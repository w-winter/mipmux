import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readlink, rename, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { MipmuxRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import type { CallerBuildRequest, CallerJobRequest, CallerPatch, CallerPrepareRequest } from '../src/contracts/caller-context.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import { toolJSON } from './fixtures/tool-json.js';

const command = resolve('dist/cli/main.js');
const nativeExecutable = resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`);
const git = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const hostBudgetUnits = 200000;
const finalTask = 'Final investigation task for the recipient.';
const snapshotReply = Compile(Type.Object({ jobId: Type.String(), state: Type.String(), localSettled: Type.Boolean() }));
const failedReply = Compile(Type.Object({ jobId: Type.String(), state: Type.Literal('failed'), code: Type.String(),
  discovery: Type.Null() }));
const readyReply = Compile(Type.Object({ jobId: Type.String(), state: Type.Literal('ready'),
  bundle: Type.Object({ directory: Type.String() }) }));
const errorReply = Compile(Type.Object({ kind: Type.Literal('error'), code: Type.String() }));
const prepared = Compile(Type.Object({ kind: Type.Literal('ready'), directory: Type.String(),
  added: Type.Array(Type.Object({ kind: Type.String(), path: Type.Optional(Type.String()) })) }));

type Phase = 'finish' | 'hold' | 'fail';
/** What the scripted provider does next; `held` runs when a request is held. */
interface ScriptState { phase: Phase; held: () => void }

/** A Git root with a reviewed worktree change, a scripted discovery provider and a core-tools MCP configuration. */
async function fixture(t: TestContext) {
  const state: ScriptState = { phase: 'finish', held: () => {} };
  const provider = await scriptedProvider(() => {
    if (state.phase === 'hold') return { kind: 'hold', entered: () => state.held() };
    if (state.phase === 'fail') return { kind: 'error' };
    return { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 };
  });
  t.after(() => provider.close());
  const base = provider.directory, root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  const files = { 'plan.md': '# Plan\n\nKeep every evidence kind.\n', 'Full.swift': 'struct Full { let value: Int }\n',
    'Slice.txt': 'first\nsecond\nthird\n', 'Other.swift': 'struct Other {}\n' };
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  run(['add', '.']); run(['commit', '-qm', 'base']);
  await writeFile(join(root, 'Full.swift'), files['Full.swift'] + '// reviewed change\n');
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), nativeExecutable, nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: hostBudgetUnits, defaultEnhancementMode: 'preserve' as const, credentialPaths: [],
    // The server and the verifying library runtime read the same user Git configuration, so their policies agree.
    git: { executable: git, userConfiguration: { home: base, xdgConfigHome: null } } };
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ ...options, discovery: provider.config, defaultMaxOutputBytes: 100000 }));
  const connect = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'caller-context', version: '1' });
    t.after(() => client.close());
    await client.connect(transport);
    return client;
  };
  const workspace = { roots: [{ name: 'r', absolutePath: root }], outputRoot: out };
  return { state, provider, base, root, out, options, workspace, connect };
}

const build = (client: Client, args: CallerBuildRequest) => client.callTool({ name: 'context_builder', arguments: args });
const job = (client: Client, args: CallerJobRequest) => client.callTool({ name: 'context_job', arguments: args });
async function settle(client: Client, jobId: string) {
  for (;;) {
    const reply = toolJSON(await job(client, { op: 'wait', jobId, durationMs: 10000 }));
    if (snapshotReply.Parse(reply).localSettled) return reply;
  }
}
const started = async (client: Client, args: CallerBuildRequest) => {
  const reply = await build(client, args);
  assert.equal(reply.isError, false, JSON.stringify(reply));
  return snapshotReply.Parse(toolJSON(reply)).jobId;
};

test('compact core inputs publish and prepare complete required evidence', async t => {
  const f = await fixture(t), client = await f.connect();
  const runtime = new MipmuxRuntime({ ...f.options, cachePath: join(f.base, 'verification-cache') });
  t.after(() => runtime.close());
  const reviewPatch = { id: 'review', root: 'r', comparison: { kind: 'worktree', base: 'HEAD', includeUntracked: false } } satisfies CallerPatch;
  const evidence = {
    required: [{ root: 'r', path: 'plan.md' }, { root: 'r', path: 'Slice.txt', lines: [{ start: 2, end: 2 }] }],
    documents: [{ id: 'ledger', role: 'evidence', origin: 'fixture', text: 'PRIOR FINDING LEDGER\n' }],
    patches: [{ ...reviewPatch, paths: ['Full.swift'] }],
  } satisfies Pick<CallerBuildRequest, 'required' | 'documents' | 'patches'>;
  const defaults = readyReply.Parse(await settle(client, await started(client, { workspace: f.workspace, purpose: 'investigation',
    task: 'Collect the reviewed change', outputName: 'run-defaults', ...evidence })));
  const explicit = readyReply.Parse(await settle(client, await started(client, { workspace: f.workspace, purpose: 'investigation',
    task: 'Collect the reviewed change', outputName: 'run-explicit', ...evidence, copyPreset: 'standard', budgetUnits: 150000,
    enhancementMode: 'augment', patches: [reviewPatch] })));
  const savedDefaults = (await verifyBundle(defaults.bundle.directory)).manifest;
  const savedExplicit = (await verifyBundle(explicit.bundle.directory)).manifest;
  // Patches select the Review preset unless the caller names one; budget and enhancement come from the host unless overridden.
  assert.deepEqual([savedDefaults.request.copyPresetSelector, savedDefaults.request.budgetUnits, savedDefaults.request.enhancementMode],
    ['codeReview', hostBudgetUnits, 'preserve']);
  assert.deepEqual([savedExplicit.request.copyPresetSelector, savedExplicit.request.budgetUnits, savedExplicit.request.enhancementMode],
    ['standard', 150000, 'augment']);
  assert.deepEqual(savedDefaults.request.requiredSources, [{ kind: 'full', source: { root: 'r', path: 'plan.md' } },
    { kind: 'slices', source: { root: 'r', path: 'Slice.txt' }, ranges: [{ start: 2, end: 2, description: null }] }]);
  assert.deepEqual(savedDefaults.request.patches.map(patch => patch.kind === 'localPatch' ? [patch.comparison, patch.scope] : null), [[
    { kind: 'worktree', base: { kind: 'commit', ref: 'HEAD' }, includeUntracked: false }, { kind: 'paths', paths: ['Full.swift'] }]]);
  assert.deepEqual(savedExplicit.request.patches.map(patch => patch.kind === 'localPatch' ? patch.scope : null), [{ kind: 'all' }]);
  assert.deepEqual(savedDefaults.materials.map(material => material.kind === 'source'
    ? [material.selection.kind, material.selection.source.path, material.required] : [material.kind]).sort(),
    [['document'], ['full', 'plan.md', true], ['patch'], ['slices', 'Slice.txt', true]].sort());
  await verifyCurrentBundle(defaults.bundle.directory, runtime, new AbortController().signal);

  const prepare = (args: Omit<CallerPrepareRequest, 'workspace' | 'bundle' | 'prompt'>) => client.callTool({ name: 'context_prepare',
    arguments: { workspace: f.workspace, bundle: 'run-defaults', prompt: finalTask, ...args } });
  for (const edit of [{ remove: ['r/plan.md'] }, { demote: ['r/Slice.txt'] }]) {
    const refused = await prepare({ outputName: 'run-trimmed', ...edit });
    assert.equal(errorReply.Parse(toolJSON(refused)).code, 'invalidSelection');
  }
  const receipt = prepared.Parse(toolJSON(await prepare({ outputName: 'run-final', required: [{ root: 'r', path: 'Other.swift' }] })));
  assert.deepEqual(receipt.added.map(entry => entry.kind + ':' + entry.path), ['full:r/Other.swift']);
  const final = await verifyCurrentBundle(receipt.directory, runtime, new AbortController().signal);
  assert.equal(final.manifest.prompt, finalTask);
  assert(final.manifest.request.requiredSources.some(selection => selection.source.path === 'plan.md'));
  await writeFile('test-output/caller-context-proof.json', JSON.stringify({ defaults, explicit, receipt,
    requests: [savedDefaults.request, savedExplicit.request] }, null, 2) + '\n');
});

test('concurrent destination retries share one job and conflicts never start a second discovery', async t => {
  const f = await fixture(t), client = await f.connect();
  f.state.phase = 'hold';
  const held = new Promise<void>(resolve => { f.state.held = resolve; });
  const request = { workspace: f.workspace, purpose: 'investigation', task: 'Inspect the model', outputName: 'run-shared' } satisfies CallerBuildRequest;
  const spelled = { ...request, workspace: { ...f.workspace, exclusions: [] }, copyPreset: 'standard', budgetUnits: hostBudgetUnits,
    enhancementMode: 'preserve' } satisfies CallerBuildRequest;
  const [first, second] = await Promise.all([started(client, request), started(client, spelled)]);
  assert.equal(second, first);
  for (const conflicting of [{ ...request, task: 'A different task' },
    { ...request, workspace: { ...f.workspace, exclusions: [{ kind: 'prefix', root: 'r', path: 'Other.swift' }] } }] satisfies CallerBuildRequest[]) {
    const refused = await build(client, conflicting);
    assert.equal(refused.isError, true);
    assert.equal(errorReply.Parse(toolJSON(refused)).code, 'outputNameConflict');
  }
  // Invalid inputs that would widen scope or bypass the declaration are rejected rather than reinterpreted.
  for (const invalid of [{ ...request, outputName: 'run-paths', patches: [{ id: 'p', root: 'r', paths: [],
    comparison: { kind: 'staged', base: 'HEAD' } }] }, { workspaceId: 'w', requestId: 'r', request: { task: 'Old shape' } }]) {
    assert.equal((await client.callTool({ name: 'context_builder', arguments: invalid })).isError, true);
  }
  for (const misplaced of [{ op: 'cancel', jobId: first, durationMs: 0 }, { op: 'wait', jobId: first }]) {
    const refused = await client.callTool({ name: 'context_job', arguments: misplaced });
    assert.equal(refused.isError, true); assert.equal(errorReply.Parse(toolJSON(refused)).code, 'invalidRequest');
  }
  await held;
  assert.equal(snapshotReply.Parse(toolJSON(await job(client, { op: 'status', jobId: first }))).localSettled, false);
  assert.equal(f.provider.requests.length, 1);
  const otherOutput = join(f.base, 'other-out'); await mkdir(otherOutput);
  const elsewhere = await started(client, { ...request, workspace: { ...f.workspace, outputRoot: otherOutput } });
  assert.notEqual(elsewhere, first);
  for (const jobId of [first, elsewhere]) await job(client, { op: 'cancel', jobId });
  f.state.phase = 'finish';
  const completed = await started(client, { ...request, outputName: 'run-complete' });
  readyReply.Parse(await settle(client, completed));
  await lstat(join(f.out, 'run-complete'));
  assert.equal(await started(client, { ...request, outputName: 'run-complete' }), completed);
  await writeFile('test-output/caller-context-retry-proof.json', JSON.stringify({ first, elsewhere, completed,
    providerRequests: f.provider.requests.length }, null, 2) + '\n');
});

test('terminal failures retain their destination key until connection closure', async t => {
  const f = await fixture(t), client = await f.connect();
  const request = { workspace: f.workspace, purpose: 'investigation', task: 'Inspect the model' } satisfies Omit<CallerBuildRequest, 'outputName'>;
  f.state.phase = 'fail';
  const failedJob = await started(client, { ...request, outputName: 'run-failed' });
  assert.equal(snapshotReply.Parse(await settle(client, failedJob)).state, 'failed');
  const requestsAfterFailure = f.provider.requests.length;
  assert.equal(await started(client, { ...request, outputName: 'run-failed' }), failedJob);
  assert.equal(f.provider.requests.length, requestsAfterFailure);
  f.state.phase = 'hold';
  const cancelledJob = await started(client, { ...request, outputName: 'run-cancelled' });
  await job(client, { op: 'cancel', jobId: cancelledJob });
  assert.equal(snapshotReply.Parse(await settle(client, cancelledJob)).state, 'cancelled');
  assert.equal(await started(client, { ...request, outputName: 'run-cancelled' }), cancelledJob);
  f.state.phase = 'finish';
  const retried = await started(client, { ...request, outputName: 'run-failed-2' });
  assert.notEqual(retried, failedJob);
  readyReply.Parse(await settle(client, retried));
  const stranger = await f.connect();
  const foreign = await job(stranger, { op: 'status', jobId: retried });
  assert.equal(errorReply.Parse(toolJSON(foreign)).code, 'unknownJob');
});

test('occupied output names fail before discovery', async t => {
  const f = await fixture(t), client = await f.connect();
  const request = { workspace: f.workspace, purpose: 'investigation', task: 'Inspect the model' } satisfies Omit<CallerBuildRequest, 'outputName'>;
  await mkdir(join(f.out, 'taken-directory')); await writeFile(join(f.out, 'taken-file'), 'existing\n');
  await symlink(join(f.base, 'absent-target'), join(f.out, 'taken-link'));
  const before = (await readdir(f.out)).sort();
  for (const outputName of ['taken-directory', 'taken-file', 'taken-link']) {
    const failure = failedReply.Parse(await settle(client, await started(client, { ...request, outputName })));
    assert.equal(failure.code, 'alreadyExists', outputName);
  }
  assert.equal(f.provider.requests.length, 0);
  assert.deepEqual((await readdir(f.out)).sort(), before);
  assert.equal(await readlink(join(f.out, 'taken-link')), join(f.base, 'absent-target'));
  const completed = await started(client, { ...request, outputName: 'run-done' });
  readyReply.Parse(await settle(client, completed));
  const requests = f.provider.requests.length;
  const fresh = await f.connect();
  const repeated = failedReply.Parse(await settle(fresh, await started(fresh, { ...request, outputName: 'run-done' })));
  assert.equal(repeated.code, 'alreadyExists'); assert.notEqual(repeated.jobId, completed);
  assert.equal(f.provider.requests.length, requests);

  await rename(f.out, f.out + '-original'); await mkdir(f.out);
  const changed = failedReply.Parse(await settle(client, await started(client, { ...request, outputName: 'run-after-change' })));
  assert.equal(changed.code, 'rootChanged');
  const missing = await build(fresh, { ...request, workspace: { ...f.workspace, outputRoot: join(f.base, 'missing') },
    outputName: 'run-missing' });
  assert.equal(errorReply.Parse(toolJSON(missing)).code, 'notFound');
  assert.equal(f.provider.requests.length, requests);
});
