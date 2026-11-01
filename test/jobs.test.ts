import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MipmuxRuntime, verifyBundle, verifyCurrentBundle, type ContextBuildRequest } from '../src/index.js';
import { contextRequestValidator } from '../src/contracts/context.js';
import type { JobSnapshot } from '../src/contracts/jobs.js';
import type { DiscoveryRunner } from '../src/discovery/runner.js';
import { compose } from '../src/cli/config.js';
import { WorkspaceFailure } from '../src/workspace/values.js';
import { fixtureSettings } from './fixtures/discovery-settings.js';

test('configured context defaults resolve omitted settings and explicit request overrides across drafts and jobs', async () => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'mipmux-assembly-budget-'));
  await mkdir(join(directory, 'root')); await mkdir(join(directory, 'out'));
  const contextBudgetUnits = 350000;
  const options = { copyContext: copyContext(), cachePath: join(directory, 'cache'), credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {},
    contextBudgetUnits, defaultEnhancementMode: 'preserve' as const };
  const { runtime } = compose({ ...options, git: null, discovery: null, defaultMaxOutputBytes: 10000, tools: 'core' }, null);
  const signal = new AbortController().signal;
  const observed: { enhancementMode: string; tokenBudget: number }[] = [];
  const runner: DiscoveryRunner = { settings: fixtureSettings, run: async input => {
    observed.push({ enhancementMode: input.enhancementMode, tokenBudget: input.tokenBudget });
    throw new WorkspaceFailure('fixtureDefaultsObserved');
  } };
  const request = { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', purpose: 'investigation' as const, requiredSources: [],
    documents: [], patches: [], discoveryHints: [] };
  const cases = [
    { name: 'defaults', overrides: {}, enhancementMode: 'preserve', budgetUnits: contextBudgetUnits },
    { name: 'mode', overrides: { enhancementMode: 'augment' }, enhancementMode: 'augment', budgetUnits: contextBudgetUnits },
    { name: 'budget', overrides: { budgetUnits: 500000 }, enhancementMode: 'preserve', budgetUnits: 500000 },
    { name: 'both', overrides: { enhancementMode: 'fullRewrite', budgetUnits: 123000 }, enhancementMode: 'fullRewrite', budgetUnits: 123000 },
  ] as const;
  try {
    const client = runtime.createClient(runner);
    const spec = { roots: [{ name: 'r', absolutePath: join(directory, 'root') }], exclusions: [], outputRoot: join(directory, 'out') };
    const workspace = await client.declare(spec, signal);
    const manualWorkspace = await runtime.declare(spec, signal);
    const terminals: JobSnapshot[] = [];
    for (const entry of cases) {
      const input = contextRequestValidator.Parse({ ...request, ...entry.overrides, outputName: entry.name });
      const draft = await manualWorkspace.createDraft(input, signal);
      const result = await draft.finalize(signal);
      assert(result.kind === 'ready');
      assert.equal(result.manifest.request.enhancementMode, entry.enhancementMode);
      assert.equal(result.manifest.request.budgetUnits, entry.budgetUnits);
      assert.equal(result.manifest.accounting.allowance, entry.budgetUnits);
      await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, runtime, signal);
      await draft.close();
      const job = client.build(workspace.id, entry.name, input);
      const terminal = await client.wait(job.jobId, 10000, signal, () => {});
      assert.equal(terminal.state, 'failed');
      if (terminal.state !== 'failed') assert.fail('Not failed');
      assert.equal(terminal.code, 'fixtureDefaultsObserved');
      terminals.push(terminal);
    }
    await manualWorkspace.close();
    assert.deepEqual(observed, cases.map(entry => ({ enhancementMode: entry.enhancementMode, tokenBudget: entry.budgetUnits - 1500 })));
    await writeFile('test-output/configured-defaults.json', JSON.stringify({ contextBudgetUnits, cases, observed, terminals }, null, 2) + '\n');
  } finally { await runtime.close(); }
});

test('client jobs deduplicate admission, isolate ids, release cancelled work', async () => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'mipmux-jobs-'));
  await mkdir(join(directory, 'root')); await mkdir(join(directory, 'out'));
  await writeFile(join(directory, 'root/file.txt'), 'source');
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const runner: DiscoveryRunner = { settings: fixtureSettings, run: async (_input, _tools, signal) => {
    calls++; entered();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new Error('Cancelled boundary');
  } };
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(directory, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {} });
  const signal = new AbortController().signal;
  const request: ContextBuildRequest = { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation', requiredSources: [],
    documents: [], patches: [], budgetUnits: 10000,
    discoveryHints: [], outputName: 'packet' };
  try {
    const a = runtime.createClient(runner), b = runtime.createClient(runner);
    const workspace = await a.declare({ roots: [{ name: 'r', absolutePath: join(directory, 'root') }], exclusions: [], outputRoot: join(directory, 'out') }, signal);
    const first = a.build(workspace.id, 'one', request);
    assert.equal(a.build(workspace.id, 'one', request).jobId, first.jobId);
    assert.throws(() => a.build(workspace.id, 'one', { ...request, task: 'different' }), /requestIdConflict/);
    assert.throws(() => b.result(first.jobId), /unknownJob/);
    await a.closeWorkspace(workspace.id);
    await started;
    const waiting = await a.wait(first.jobId, 0, signal, () => {});
    assert.equal(waiting.state, 'discovering');
    const observer = new AbortController(); observer.abort();
    await assert.rejects(async () => a.wait(first.jobId, 1000, observer.signal, () => {}));
    assert.equal(a.result(first.jobId).state, 'discovering');
    a.cancel(first.jobId);
    const cancelled = await a.wait(first.jobId, 10000, signal, () => {});
    assert.equal(cancelled.state, 'cancelled'); assert.equal(calls, 1);
    assert.equal(cancelled.sharedIndexInterest, 'released');
    assert.deepEqual(a.result(first.jobId), cancelled);
    const nextWorkspace = await a.declare({ roots: [{ name: 'r', absolutePath: join(directory, 'root') }], exclusions: [], outputRoot: join(directory, 'out') }, signal);
    const manual = await a.createDraft(nextWorkspace.id, request, signal);
    await a.prompt(manual.id, { expectedRevision: 0, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify({ clarifiedTask: 'Task', architecture: 'Files', relationships: [], ambiguities: [] })  }, signal);
    await a.closeWorkspace(nextWorkspace.id);
    assert.equal((await a.finalize(manual.id, signal)).kind, 'ready');
    assert.equal((await a.inspect(manual.id, { view: 'metadata', continuation: null, maxOutputBytes: 10000 }, new AbortController().signal)).kind, 'metadata');
    await assert.rejects(a.explore(nextWorkspace.id, { name: 'read_file', input: { root: 'r', path: 'file.txt',
      start_line: null, offset: null, limit: null, continuation: null, maxOutputBytes: 10000 } }, signal, manual.id), /operationClosed|workspaceClosed/);
    await a.close(); await b.close();
  } finally { await runtime.close(); }
});
