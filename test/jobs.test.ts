import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SmipRuntime, type ContextBuildRequest } from '../src/index.js';
import type { DiscoveryRunner } from '../src/discovery/runner.js';

test('client jobs deduplicate admission, isolate ids, reject unknown budgets and release cancelled work', async () => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(resolve('test-output/jobs-'));
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
  const runtime = new SmipRuntime({ cachePath: join(directory, 'cache'), credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {} });
  const signal = new AbortController().signal;
  const request: ContextBuildRequest = { task: 'Inspect', constraints: '', purpose: 'investigation', requiredSources: [],
    documents: [], patches: [], allowance: { kind: 'net', units: 10000, method: 'utf8-21-over-80-v1', overheadReserved: true },
    discoveryHints: [], outputName: 'packet' };
  try {
    const a = runtime.createClient(runner), b = runtime.createClient(runner);
    const workspace = await a.declare({ roots: [{ name: 'r', absolutePath: join(directory, 'root') }], exclusions: [], outputRoot: join(directory, 'out') }, signal);
    assert.throws(() => a.build(workspace.id, 'unknown', { ...request, allowance: null }), /allowanceUnavailable/);
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
    await a.update(manual.id, { expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'handoff',
      handoff: { clarifiedTask: 'Task', architecture: 'Files', relationships: [], ambiguities: [] } } }, signal);
    await a.closeWorkspace(nextWorkspace.id);
    assert.equal((await a.finalize(manual.id, signal)).kind, 'ready');
    assert.equal(a.inspect(manual.id, { view: 'metadata', continuation: null, maxOutputBytes: 10000 }).kind, 'metadata');
    await assert.rejects(a.explore(nextWorkspace.id, { name: 'read_file', input: { root: 'r', path: 'file.txt',
      shape: { kind: 'whole' }, continuation: null, maxOutputBytes: 10000 } }, signal, manual.id), /operationClosed|workspaceClosed/);
    await a.close(); await b.close();
  } finally { await runtime.close(); }
});
