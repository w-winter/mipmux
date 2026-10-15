import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import type { OwnedProcess, ProcessSpec } from '../src/runtime/process-supervisor.js';
import type { ContextBuildRequest } from '../src/contracts/context.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';

for (const boundary of ['read', 'search'] as const) test(`worker ${boundary === 'read' ? 'exit' : 'protocol failure'} retires and joins a real held ${boundary} before publishing the job terminal`, async t => {
  const search = { mode: 'content' as const, query: { kind: 'literal' as const, text: 'source', caseSensitive: true, wholeWord: true },
    filters: { roots: [], directories: [], include: [], exclude: [], extensions: [] }, before: 0, after: 0,
    countOnly: false, maxResults: 50, maxOutputBytes: 2000, continuation: null };
  const provider = await scriptedProvider(() => boundary === 'search' ? { kind: 'tool', name: 'file_search', input: search, stop: 'tool_use', tokens: 10 } : ({ kind: 'tool', name: 'read_file', input: {
    root: 'r', path: 'file.txt', start_line: null, offset: null, limit: null, maxOutputBytes: 2000, continuation: null,
  }, stop: 'tool_use', tokens: 10 }));
  provider.config.policy.compaction.enabled = false;
  const root = join(provider.directory, 'root'), outputRoot = join(provider.directory, 'out');
  await mkdir(root); await mkdir(outputRoot); await writeFile(join(root, 'file.txt'), 'source\n');
  const nativeExecutable = resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`);
  const runtime = new SmipRuntime({ cachePath: join(provider.directory, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable, nativeEnvironment: {}, terminationGraceMs: 100 });
  const spawn = runtime.supervisor.spawn.bind(runtime.supervisor);
  let armed = false;
  const state: { worker: OwnedProcess | null } = { worker: null };
  const held: OwnedProcess[] = [];
  let entered!: () => void;
  const holding = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(runtime.supervisor, 'spawn', (spec: ProcessSpec) => {
    if (armed && spec.executable === nativeExecutable) {
      const process = spawn({ ...spec, executable: globalThis.process.execPath,
        args: [resolve('test/fixtures/held-native-proxy.mjs'), ...spec.args],
        env: { ...spec.env, SMIP_NATIVE: nativeExecutable, SMIP_HELD_OPERATION: boundary === 'read' ? 'readSource' : 'scanLiteralLines' } });
      held.push(process);
      let stderr = '';
      process.child.stderr.on('data', bytes => { stderr += bytes.toString(); if (stderr.includes(boundary === 'read' ? 'SMIP_READ_HELD' : 'SMIP_SEARCH_HELD')) entered(); });
      return process;
    }
    const process = spawn(boundary === 'search' && spec.args.some(arg => arg.endsWith('/pi-worker.js'))
      ? { ...spec, args: [resolve('test/fixtures/protocol-retirement-proxy.mjs'), ...spec.args] } : spec);
    if (spec.args.some(arg => arg.endsWith('/pi-worker.js'))) state.worker = process;
    return process;
  });
  const client = runtime.createClient(new PiRunner(provider.config, runtime.supervisor));
  try {
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot }, new AbortController().signal);
    await client.refresh(workspace.id, new AbortController().signal);
    armed = true;
    const request: ContextBuildRequest = { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation', requiredSources: [], documents: [], patches: [],
      discoveryHints: [], budgetUnits: 10000, outputName: 'packet' };
    const job = client.build(workspace.id, 'held-read', request);
    await holding;
    assert(state.worker);
    if (boundary === 'search') state.worker.child.kill('SIGUSR1');
    else await state.worker.stop();
    const result = await client.wait(job.jobId, 10000, new AbortController().signal, () => {});
    assert.equal(result.state, 'failed', JSON.stringify(result));
    assert.equal(result.localSettled, true);
    assert.equal(result.sharedIndexInterest, 'released');
    if (result.state !== 'failed') assert.fail('Missing failure terminal');
    assert.equal(result.discovery?.workerClosed, true);
    assert.equal(result.discovery?.parentToolsSettled, true);
    assert.equal(result.discovery?.acceptedRuns, 1);
    const joins = await Promise.all(held.map(process => process.closed));
    assert(joins.length > 0);
    armed = false;
    const read = await client.explore(workspace.id, { name: 'read_file', input: { root: 'r', path: 'file.txt', start_line: null, offset: null, limit: null, maxOutputBytes: 2000, continuation: null } }, new AbortController().signal);
    assert('kind' in read && read.kind === 'read');
    const searched = await client.explore(workspace.id, { name: 'file_search', input: search }, new AbortController().signal);
    assert('kind' in searched && searched.kind === 'search');
    await writeFile(join(provider.directory, 'retirement-proof.json'), JSON.stringify({ result, joins, otherOwnerUsable: true }));
  } finally { await runtime.close(); await provider.close(); }
});
