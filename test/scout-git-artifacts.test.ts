import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Compile } from 'typebox/compile';
import { SmipRuntime, verifyBundle, type ContextBuildRequest } from '../src/index.js';
import { gitValidator, type GitRequest } from '../src/contracts/git.js';
import { GitArtifactReply } from '../src/contracts/git-artifact.js';
import { selectionValidator } from '../src/contracts/selection.js';
import { scopedCall } from '../src/discovery/scoped-tools.js';
import { piToolResult } from '../src/runtime/tool-result.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import type { RuntimeOptions } from '../src/runtime/smip-runtime.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import Type from 'typebox';
import { GitArtifactReposReply } from '../src/contracts/git-artifact.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const signal = () => new AbortController().signal;
const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const replyValidator = Compile(GitArtifactReply);

async function fixture(makeRuntime: (options: RuntimeOptions) => SmipRuntime = options => new SmipRuntime(options)) {
  const base = await mkdtemp(join(tmpdir(), 'smip-scout-artifacts-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'file.txt'), 'base\n'); await writeFile(join(root, 'slice.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(root, 'code.swift'), 'struct Example { let value: Int }\n');
  run(['add', '.']); run(['commit', '-qm', 'base']); await writeFile(join(root, 'file.txt'), 'scout artifact change\n');
  const request: ContextBuildRequest = { task: 'Collect Git evidence', constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } },
      { kind: 'slices', source: { root: 'r', path: 'slice.txt' }, ranges: [{ start: 2, end: 2, description: null }] },
      { kind: 'codemap', source: { root: 'r', path: 'code.swift' } }] },
    requiredSources: [], documents: [], patches: [], copyPreset: 'standard', storedPrompts: [],
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: 'packet' };
  const options = { cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000, git: { executable: git } };
  const runtime = makeRuntime(options);
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal());
  const draft = await workspace.createDraft(request, signal());
  const publication = (extra: Partial<Extract<GitRequest, { op: 'diff'; artifacts: true }>>) => gitValidator.Parse(gitValidator.Default({
    op: 'diff', artifacts: true, snapshot_id: 'scout', maxOutputBytes: 100000, ...extra }));
  return { root, out, options, request, runtime, workspace, draft, publication };
}

test('scout publication commits mutable primary artifacts before reply encoding and installs grants afterward', async () => {
  const f = await fixture(), operation = await f.workspace.openOperation(signal());
  try {
    let pendingRead: Promise<void> | null = null;
    const reply = replyValidator.Parse(await scopedCall({ name: 'git', input: f.publication({ mode: 'STANDARD', scope: 'ALL',
      inline: { map: true, mode: 'BRIEF', max_lines: 0 } }) }, f.draft, operation, signal(), value => {
      const encoded = replyValidator.Parse(value);
      pendingRead = assert.rejects(f.draft.readGitArtifact(encoded.primary_artifacts.map, signal()), /gitArtifactNotAdvertised/);
      return piToolResult(value);
    }));
    await pendingRead;
    assert.equal(reply.inline?.returned_lines, 1);
    assert.deepEqual(reply.primary_artifacts.auto_selected, [reply.primary_artifacts.map, reply.primary_artifacts.all_patch]);
    const selected = await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get',
      maxOutputBytes: 100000 })), signal());
    assert.equal(selected.revision, 1); assert.equal(selected.summary.full_count, 3);
    assert.equal(selected.summary.slice_count, 1); assert.equal(selected.summary.codemap_count, 1);
    assert.equal(selected.codemap_auto_enabled, false);
    assert((await f.draft.readGitArtifact(reply.primary_artifacts.map, signal())).text.includes('scout'));
    const repeated = replyValidator.Parse(await scopedCall({ name: 'git', input: f.publication({}) }, f.draft, operation, signal(), piToolResult));
    assert(!repeated.primary_artifacts.auto_selected?.length); assert.equal(f.draft.revision, 1);
    const perFile = reply.primary_artifacts.per_file_patches?.[0]?.selection_path; assert(perFile);
    const removed = await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'remove',
      paths: [reply.primary_artifacts.all_patch], maxOutputBytes: 100000 })), signal());
    assert.equal(removed.revision, 2);
    await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'add', paths: [perFile],
      maxOutputBytes: 100000 })), signal());
    const ready = await f.draft.finalize(signal()); assert(ready.kind === 'ready'); await verifyBundle(ready.directory);
    await writeFile('test-output/scout-git-artifacts-proof.json', JSON.stringify({ reply, selected, repeated, ready,
      grantsInstalledAfterEncoding: true, primariesMutable: true }, null, 2) + '\n');
  } finally { await operation.close(); await f.runtime.close(); }
});

test('failed or cancelled artifact replies retain publication and committed selection but install no new grant', async () => {
  for (const effect of ['cap', 'cancelEncoding', 'cancelGrant'] as const) {
    const controller = new AbortController(); let encoded = false;
    const f = await fixture(options => {
      class Runtime extends SmipRuntime {
        override makeBridge() {
          class Bridge extends BridgeClient {
            publicationOwner = false;
            override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
              if (operation.kind === 'normalizeGitPublicationOptions') this.publicationOwner = true;
              const result = await super.request(operation, requestSignal);
              if (effect === 'cancelGrant' && encoded && this.publicationOwner && operation.kind === 'revalidateGitTargets') {
                controller.abort(); throw new NativeFailure('rootChanged', null);
              }
              return result;
            }
          }
          return new Bridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
        }
      }
      return new Runtime(options);
    }), operation = await f.workspace.openOperation(signal());
    try {
      const input = f.publication({ maxOutputBytes: effect === 'cap' ? 1 : 100000 });
      await assert.rejects(scopedCall({ name: 'git', input }, f.draft, operation, controller.signal, value => {
        encoded = true;
        if (effect === 'cancelEncoding') controller.abort();
        return piToolResult(value);
      }), effect === 'cap' ? /outputBudgetTooSmall/ : /cancelled|aborted/i);
      const [repo] = await readdir(join(f.out, '_git_data/repos')); assert(repo);
      const alias = '_git_data/repos/' + repo + '/scout/MAP.txt';
      assert((await readFile(join(f.out, alias), 'utf8')).includes('scout'));
      assert.equal(f.draft.revision, 1);
      await assert.rejects(f.draft.readGitArtifact(alias, signal()), /gitArtifactNotAdvertised/);
      const selected = await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', maxOutputBytes: 100000 })), signal());
      assert(selected.files.some(file => file.path === alias));
    } finally { await operation.close(); await f.runtime.close(); }
  }
});

test('real Pi dispatch publishes and auto-selects Git artifacts into its completed packet', async () => {
  const f = await fixture();
  const provider = await scriptedProvider((_summary, index) => index === 1
    ? { kind: 'tool', name: 'git', input: { op: 'diff', artifacts: true, snapshot_id: 'pi', maxOutputBytes: 100000 }, stop: 'tool_use', tokens: 10 }
    : { kind: 'text', text: 'complete', stop: 'end_turn', tokens: 10 });
  const runtime = new SmipRuntime({ ...f.options, cachePath: f.options.cachePath + '-pi' });
  const client = runtime.createClient(new PiRunner(provider.config, runtime.supervisor));
  try {
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.out }, signal());
    const job = client.build(workspace.id, 'scout-artifacts', { ...f.request, outputName: 'pi-packet' });
    const terminal = await client.wait(job.jobId, 10000, signal(), () => {});
    assert.equal(terminal.state, 'ready', JSON.stringify(terminal)); assert.equal(terminal.localSettled, true);
    const returned = JSON.stringify(provider.requests.at(-1)?.messages);
    assert(!returned.includes('Invalid arguments')); assert(returned.includes('auto_selected'));
    const packet = await verifyBundle(join(f.out, 'pi-packet'));
    assert.equal(packet.manifest.materials.filter(material => material.kind === 'gitMap').length, 1);
    assert.equal(packet.manifest.materials.filter(material => material.kind === 'gitPatch').length, 1);
    await writeFile('test-output/scout-git-artifacts-pi-proof.json', JSON.stringify({ terminal,
      materials: packet.manifest.materials, messages: provider.requests.at(-1)?.messages }, null, 2) + '\n');
  } finally { await runtime.close(); await provider.close(); await f.runtime.close(); }
});

test('primary commit failure warns and later grant authorization failure retains the encoded publication reply', async () => {
  let denyPrimary = true;
  const f = await fixture(options => {
    class Runtime extends SmipRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
            if (denyPrimary && operation.kind === 'authorizeGitArtifact') {
              denyPrimary = false; throw new NativeFailure('notFound', 2);
            }
            return super.request(operation, requestSignal);
          }
        }
        return new Bridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
      }
    }
    return new Runtime(options);
  });
  const operation = await f.workspace.openOperation(signal());
  try {
    const warned = replyValidator.Parse(await scopedCall({ name: 'git', input: f.publication({}) }, f.draft, operation, signal(), piToolResult));
    assert(warned.warning?.includes('could not be committed')); assert(!warned.primary_artifacts.auto_selected?.length);
    assert.equal(f.draft.revision, 0); assert((await f.draft.readGitArtifact(warned.primary_artifacts.map, signal())).text.length > 0);
    const reply = replyValidator.Parse(await scopedCall({ name: 'git', input: f.publication({ snapshot_id: 'late' }) }, f.draft, operation, signal(), value => {
      renameSync(join(f.root, '.git'), join(f.root, 'retired-git'));
      return piToolResult(value);
    }));
    renameSync(join(f.root, 'retired-git'), join(f.root, '.git'));
    assert.equal(reply.snapshot_id, 'late'); assert.equal(f.draft.revision, 1);
    await assert.rejects(f.draft.readGitArtifact(reply.primary_artifacts.map, signal()), /gitArtifactNotAdvertised/);
    assert((await readFile(join(f.out, reply.primary_artifacts.map), 'utf8')).includes('late'));
  } finally { await operation.close(); await f.runtime.close(); }
});

test('MCP publication requires an owned draft and uses the same source commit and grant pipeline', async () => {
  const f = await fixture(), config = join(f.out, '../host.json');
  await writeFile(config, JSON.stringify({ ...f.options, search: null, discovery: null, defaultMaxOutputBytes: 100000 }));
  const client = new Client({ name: 'scout-artifact-mcp', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config],
    cwd: '/', stderr: 'pipe' });
  try {
    await client.connect(transport);
    const identifier = Compile(Type.Object({ id: Type.String() }));
    const declared = await client.callTool({ name: 'workspace_declare', arguments: { spec: {
      roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.out } } });
    assert.equal(declared.isError, false); const workspaceId = identifier.Parse(declared.structuredContent).id;
    const denied = await client.callTool({ name: 'git', arguments: { workspaceId, input: { op: 'diff', artifacts: true } } });
    assert.equal(denied.isError, true); assert(JSON.stringify(denied).includes('draftRequired'));
    const created = await client.callTool({ name: 'draft_create', arguments: { workspaceId, request: f.request } });
    assert.equal(created.isError, false); const draftId = identifier.Parse(created.structuredContent).id;
    const published = await client.callTool({ name: 'git', arguments: { workspaceId, draftId,
      input: { op: 'diff', artifacts: true, snapshot_id: '../invalid', mode: 'QUICK' } } });
    assert.equal(published.isError, false, JSON.stringify(published));
    const reply = replyValidator.Parse(published.structuredContent);
    assert.notEqual(reply.snapshot_id, '../invalid'); assert(!reply.primary_artifacts.all_patch);
    assert.deepEqual(reply.primary_artifacts.auto_selected, [reply.primary_artifacts.map]);
    const selected = await client.callTool({ name: 'manage_selection', arguments: { draftId, input: { op: 'get' } } });
    assert.equal(selected.isError, false); assert(JSON.stringify(selected.structuredContent).includes(reply.primary_artifacts.map));
    await writeFile('test-output/scout-git-artifacts-mcp-proof.json', JSON.stringify({ denied, published, selected }, null, 2) + '\n');
  } finally { await client.close(); await f.runtime.close(); }
});

test('implicit multi-repository scout publication auto-selects each ordered primary pair', async () => {
  const f = await fixture(), other = join(f.out, '../other');
  await mkdir(other); await writeFile(join(other, 'other.txt'), 'base\n');
  const run = (args: string[]) => execFileSync(git, args, { cwd: other, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: other, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  run(['add', '.']); run(['commit', '-qm', 'base']); await writeFile(join(other, 'other.txt'), 'other change\n');
  const workspace = await f.runtime.declare({ roots: [{ name: 'r', absolutePath: f.root }, { name: 's', absolutePath: other }],
    exclusions: [], outputRoot: f.out }, signal());
  const draft = await workspace.createDraft({ ...f.request, initialSelection: { codemapMode: 'manual', sources: [
    { kind: 'full', source: { root: 's', path: 'other.txt' } }, { kind: 'full', source: { root: 'r', path: 'file.txt' } }] } }, signal());
  const operation = await workspace.openOperation(signal());
  try {
    const reply = Compile(GitArtifactReposReply).Parse(await scopedCall({ name: 'git', input: f.publication({ snapshot_id: 'multi' }) },
      draft, operation, signal(), piToolResult));
    assert.equal(reply.aggregate.repo_count, 2);
    const aliases = reply.repos.flatMap(repo => 'diff' in repo ? repo.primary_artifacts?.auto_selected ?? [] : []);
    assert.equal(aliases.length, 4); assert.equal(draft.revision, 1);
    for (const alias of aliases) assert((await draft.readGitArtifact(alias, signal())).text.length > 0);
    const selected = await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', maxOutputBytes: 100000 })), signal());
    assert.deepEqual(selected.files.slice(-4).map(file => file.path), aliases);
  } finally { await operation.close(); await f.runtime.close(); }
});
