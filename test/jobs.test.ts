import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SmipRuntime, type ContextBuildRequest } from '../src/index.js';
import type { JobSnapshot } from '../src/contracts/jobs.js';
import type { DiscoveryRunner } from '../src/discovery/runner.js';
import { compose } from '../src/cli/config.js';

test('the user assembly ceiling rejects caller overrides before discovery and permits allowances at the ceiling', async () => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'smip-assembly-budget-'));
  await mkdir(join(directory, 'root')); await mkdir(join(directory, 'out'));
  const contextBudgetUnits = 10000;
  const options = { copyContext: copyContext(), cachePath: join(directory, 'cache'), credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    contextBudgetUnits };
  const { runtime } = compose({ ...options, git: null, discovery: null, defaultMaxOutputBytes: 10000 }, null);
  const signal = new AbortController().signal;
  let calls = 0;
  const runner: DiscoveryRunner = { run: async () => { calls++; throw new Error('Unexpected discovery dispatch'); } };
  const request: ContextBuildRequest = { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation', requiredSources: [],
    documents: [], patches: [], budgetUnits: contextBudgetUnits,
    discoveryHints: [], outputName: 'packet' };
  try {
    const client = runtime.createClient(runner);
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: join(directory, 'root') }], exclusions: [], outputRoot: join(directory, 'out') }, signal);
    const terminals: JobSnapshot[] = [];
    for (const budgetUnits of [contextBudgetUnits + 1]) {
      await assert.rejects(client.createDraft(workspace.id, { ...request, budgetUnits }, signal), /assemblyBudgetExceeded/);
      const job = client.build(workspace.id, 'oversized', { ...request, budgetUnits });
      const terminal = await client.wait(job.jobId, 10000, signal, () => {});
      assert.equal(terminal.state, 'failed');
      if (terminal.state !== 'failed') assert.fail('Not failed');
      assert.equal(terminal.code, 'assemblyBudgetExceeded');
      terminals.push(terminal);
    }
    assert.equal(calls, 0);
    const draft = await client.createDraft(workspace.id, request, signal);
    const inspection = (await client.inspect(draft.id, { view: 'metadata', continuation: null, maxOutputBytes: 10000 }, new AbortController().signal));
    assert(inspection.kind === 'metadata'); assert.equal(inspection.measurement.allowance, contextBudgetUnits);
    await writeFile(join(directory, 'assembly-budget-proof.json'), JSON.stringify({ contextBudgetUnits, calls, terminals, inspection }, null, 2));
  } finally { await runtime.close(); }
});

test('client jobs deduplicate admission, isolate ids, release cancelled work', async () => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'smip-jobs-'));
  await mkdir(join(directory, 'root')); await mkdir(join(directory, 'out'));
  await writeFile(join(directory, 'root/file.txt'), 'source');
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const runner: DiscoveryRunner = { run: async (_input, _tools, signal) => {
    calls++; entered();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new Error('Cancelled boundary');
  } };
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(directory, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {} });
  const signal = new AbortController().signal;
  const request: ContextBuildRequest = { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation', requiredSources: [],
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
    await a.update(manual.id, { expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify({ clarifiedTask: 'Task', architecture: 'Files', relationships: [], ambiguities: [] }) } }, signal);
    await a.closeWorkspace(nextWorkspace.id);
    assert.equal((await a.finalize(manual.id, signal)).kind, 'ready');
    assert.equal((await a.inspect(manual.id, { view: 'metadata', continuation: null, maxOutputBytes: 10000 }, new AbortController().signal)).kind, 'metadata');
    await assert.rejects(a.explore(nextWorkspace.id, { name: 'read_file', input: { root: 'r', path: 'file.txt',
      start_line: null, offset: null, limit: null, continuation: null, maxOutputBytes: 10000 } }, signal, manual.id), /operationClosed|workspaceClosed/);
    await a.close(); await b.close();
  } finally { await runtime.close(); }
});
