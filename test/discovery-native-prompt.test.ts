import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { compose, hostValidator } from '../src/cli/config.js';
import { verifyBundle } from '../src/index.js';
import { contextRequestValidator } from '../src/contracts/context.js';
import { bindDiscoveryPrompt } from '../src/discovery/prompt-bindings.js';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';

const content = Compile(Type.Array(Type.Object({ type: Type.Literal('text'), text: Type.String() })));
const cases = Compile(Type.Array(Type.Object({ name: Type.String(), expected: Type.String(), input: Type.Object({
  currentPrompt: Type.String(), discoveryInstructions: Type.String(), fileTree: Type.String(),
  contextBuilderPrompts: Type.Array(Type.Object({ title: Type.String(), content: Type.String() })),
}) })));
const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');

test('native default policy and source startup reach Pi for all prompt modes and preserve separate input authority', async t => {
  const reference = cases.Parse(JSON.parse(await readFile('test/fixtures/rpce-discovery-message/cases.json', 'utf8')))[1]!;
  const proof: unknown[] = [];
  for (const mode of ['fullRewrite', 'augment', 'preserve'] as const) {
    const provider = await scriptedProvider((_summary, index) => index === 1 && mode !== 'preserve'
      ? { kind: 'tool', name: 'prompt', input: { op: mode === 'augment' ? 'append' : 'set', text: 'Discovered architecture',
        expectedRevision: 0, maxOutputBytes: 12000 }, stop: 'tool_use', tokens: 10 }
      : { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 });
    t.after(() => provider.close());
    const root = join(provider.directory, 'root'), out = join(provider.directory, 'out');
    await mkdir(root); await mkdir(out); await writeFile(join(root, 'Main.swift'), 'struct Main { let value: Int }\n');
    const run = (args: string[]) => execFileSync(git, args, { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: provider.directory,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    run(['init', '-q']); run(['add', '.']); run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base']);
    const discovery = { ...provider.config, prompt: { kind: 'rpce' } };
    const config = hostValidator.Parse({ cachePath: join(provider.directory, 'cache'), nativeEnvironment: {}, credentialPaths: [],
      nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
      contextBudgetUnits: 200000, terminationGraceMs: 100, discovery, git: { executable: git }, defaultMaxOutputBytes: 100000 });
    const { runtime, client } = compose(config, null);
    try {
      const signal = new AbortController().signal;
      const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal);
      const task = reference.input.currentPrompt;
      const job = client.build(workspace.id, mode, contextRequestValidator.Parse({ task, constraints: 'FIXED_CALLER_CONSTRAINT', enhancementMode: mode,
        purpose: 'review', initialSelection: { codemapMode: 'manual', sources: [] }, requiredSources: [{ kind: 'full', source: { root: 'r', path: 'Main.swift' } }],
        documents: [], patches: [], storedPrompts: [], copyPreset: 'standard', duplicateUserInstructionsAtTop: false,
        contextBuilderPrompts: reference.input.contextBuilderPrompts, discoveryHints: [reference.input.discoveryInstructions], budgetUnits: 200000, outputName: mode }));
      const result = await client.wait(job.jobId, 10000, signal, () => {});
      assert.equal(result.state, 'ready', JSON.stringify(result)); assert(result.state === 'ready');
      const first = provider.requests[0]!;
      const system = content.Parse(first.system).map(block => block.text).join('\n');
      const allowed = system.match(/^\*\*Available tools:\*\* (.*)$/m); assert(allowed);
      for (const name of first.tools) assert(allowed[1]!.includes('`' + name + '`'), name + ' must be allowed by the policy');
      const referencePolicy = await readFile('test/fixtures/rpce-discovery/' + mode + '.md', 'utf8');
      assert.equal(system.replace(/^\*\*Codemap coverage:\*\* .+$/m, '**Codemap coverage:** __SUPPORTED_LANGUAGES__'),
        bindDiscoveryPrompt(referencePolicy) + '\n\n<cwd>\n/\n</cwd>');
      const message = Compile(Type.Object({ content: Type.Array(Type.Object({ text: Type.String() })) })).Parse(first.messages[0]).content[0]!.text;
      assert.equal(result.discovery.promptVersion, 'rpce-43a9c29');
      assert(system.includes('198500')); assert(system.includes('## Review Mode')); assert(!system.includes('Assignment.'));
      assert(!system.includes('workspace_context')); assert(system.includes('draft_inspect'));
      assert(!system.includes('<taskname=')); assert(!system.includes('ask_user'));
      assert(system.includes(mode === 'preserve' ? 'Leave the prompt COMPLETELY unchanged' : mode === 'augment' ? 'Augment the handoff prompt' : 'Craft and set the handoff prompt'));
      const tree = message.match(/^<file_map>\n([\s\S]*?)\n<\/file_map>/); assert(tree); assert(tree[1]!.includes('Main.swift'));
      const expected = reference.expected.replace('- For MCP modes (like the current context_builder mode), selected files are automatically compressed to show only their codemaps (API signatures) instead of full content, dramatically reducing token usage',
        '- Selected files use full content, slices, or codemaps (API signatures), according to their selected representation');
      assert(message.replace(tree[1]!, reference.input.fileTree).startsWith(expected));
      assert(message.includes('FIXED_CALLER_CONSTRAINT')); assert.equal(message.match(/<token_budget>/g)?.length, 1);
      assert(!message.includes('## Assignment'));
      const packet = await verifyBundle(result.bundle.directory);
      assert.equal(packet.manifest.prompt, mode === 'fullRewrite' ? 'Discovered architecture' : mode === 'augment' ? task + 'Discovered architecture' : task);
      assert(first.tools.includes('prompt')); assert(!first.tools.includes('bash')); assert(!first.tools.includes('read'));
      proof.push({ mode, result, system, message });
    } finally { await runtime.close(); }
  }
  await writeFile('test-output/discovery-native-prompt-proof.json', JSON.stringify(proof, null, 2) + '\n');
});

test('native policy/startup failure and cancellation settle without static or custom prompt substitution', async () => {
  for (const phase of ['renderDiscoveryPrompt', 'renderDiscoveryMessage', 'cancel'] as const) {
    const provider = await scriptedProvider(() => { throw Error('No model dispatch expected'); });
    const root = join(provider.directory, 'root'), out = join(provider.directory, 'out');
    await mkdir(root); await mkdir(out);
    let entered!: () => void, release!: () => void;
    const boundary = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    class Runtime extends SmipRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
            if (phase === 'cancel' && operation.kind === 'renderDiscoveryPrompt') {
              entered(); await released; signal.throwIfAborted();
            }
            if (operation.kind === phase) throw new NativeFailure('nativeIOFailed', null);
            return super.request(operation, signal);
          }
        }
        return new Bridge({ executable: this.options.nativeExecutable, env: {}, supervisor: this.supervisor });
      }
    }
    const runtime = new Runtime({ cachePath: join(provider.directory, 'cache'), nativeEnvironment: {}, credentialPaths: [],
      nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
      contextBudgetUnits: 200000, terminationGraceMs: 100 });
    const client = runtime.createClient(new PiRunner({ ...provider.config, prompt: { kind: 'rpce' } }, runtime.supervisor));
    try {
      const signal = new AbortController().signal;
      const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal);
      const job = client.build(workspace.id, phase, { task: 'Inspect', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
        initialSelection: { codemapMode: 'manual', sources: [] }, requiredSources: [], documents: [], patches: [], storedPrompts: [],
        copyPreset: 'standard', duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: phase });
      if (phase === 'cancel') { await boundary; client.cancel(job.jobId); release(); }
      const result = await client.wait(job.jobId, 10000, signal, () => {});
      assert.equal(result.state, phase === 'cancel' ? 'cancelled' : 'failed');
      assert(result.state === 'failed' || result.state === 'cancelled');
      assert.equal(result.code, phase === 'cancel' ? 'cancelled' : 'nativeIOFailed');
      assert.equal(result.localSettled, true); assert.equal(provider.requests.length, 0);
    } finally { release(); await runtime.close(); await provider.close(); }
  }
});
