import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { selectionValidator } from '../src/contracts/selection.js';
import { verifyBundle } from '../src/index.js';
import { contextRequestValidator } from '../src/contracts/context.js';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const readinessReferences = Compile(Type.Array(Type.Object({ name: Type.String(), waitMilliseconds: Type.Integer(),
  statuses: Type.Array(Type.Enum(['ready', 'pending'])), afterPresentationRelease: Type.Array(Type.Object({ workCompleted: Type.Boolean() })) })));
const referenceCases = readinessReferences.Parse(JSON.parse(await readFile('test/fixtures/rpce-readiness-observer/expected.json', 'utf8')));

for (const copyPreset of ['diffFollowUp', 'manual'] as const) {
test(`${copyPreset === 'diffFollowUp' ? 'Diff Follow-Up' : 'Manual none'} publishes while an excluded optional codemap has independently retained demand`, async () => {
  const request = contextRequestValidator.Parse({ task: 'Discuss changes', constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: 'manual', sources: [] }, requiredSources: [], documents: [], patches: [],
    duplicateUserInstructionsAtTop: false, copyPreset, budgetUnits: 100000, discoveryHints: [], outputName: 'diff-follow-up' });
  const settings = copyContext(); settings.current.fileTreeMode = 'None'; settings.current.codeMapUsage = 'none';
  const f = await fixture('held', null, settings), operation = await f.owner.openOperation(new AbortController().signal);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lease: Awaited<ReturnType<typeof operation.requestExplicitCodemap>> | null = null;
  try {
    const draft = await f.owner.createDraft(request, new AbortController().signal);
    lease = await operation.requestExplicitCodemap(f.source); await f.entering;
    await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'add', mode: 'codemap_only',
      paths: [f.source.root + '/' + f.source.path], maxOutputBytes: 100000 })), new AbortController().signal);
    let releasedForFailure = false, demandSettled = false;
    void lease.result.then(() => { demandSettled = true; }, () => {});
    const readinessMilliseconds = referenceCases.find(entry => entry.name === 'ready-completion')!.waitMilliseconds;
    timer = setTimeout(() => { releasedForFailure = true; f.release(); }, readinessMilliseconds * 2);
    const ready = await draft.finalize(new AbortController().signal);
    assert(ready.kind === 'ready'); assert.equal(releasedForFailure, false); assert.equal(demandSettled, false);
    assert.equal(await readFile(join(ready.directory, 'context.md'), 'utf8'), '<user_instructions>\nDiscuss changes\n</user_instructions>\n');
    await verifyBundle(ready.directory);
    await mkdir('test-output', { recursive: true });
    await writeFile(`test-output/${copyPreset === 'diffFollowUp' ? 'diff-follow-up' : 'manual-none'}-pending-codemap.json`, JSON.stringify({ directory: ready.directory,
      demandSettledAtPublication: demandSettled, manifest: ready.manifest }, null, 2) + '\n');
  } finally {
    if (timer !== null) clearTimeout(timer);
    f.release(); if (lease !== null) { await lease.result; await lease.release(); }
    await operation.close(); await f.runtime.close();
  }
});
}

for (const operationKind of ['finalize', 'export'] as const) test(`Manual complete ${operationKind} cancellation joins extraction and prevents publication`, async () => {
  const request = contextRequestValidator.Parse({ task: 'Inspect complete codemaps', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
    initialSelection: { codemapMode: 'manual', sources: [] }, requiredSources: [], documents: [], patches: [],
    duplicateUserInstructionsAtTop: false, copyPreset: operationKind === 'finalize' ? 'manual' : 'standard',
    budgetUnits: 100000, discoveryHints: [], outputName: 'cancelled-manual' });
  const settings = copyContext(); settings.current.fileTreeMode = 'None'; settings.current.codeMapUsage = 'complete';
  const f = await fixture('held', null, settings);
  const operation = await f.owner.openOperation(new AbortController().signal);
  try {
    const draft = await f.owner.createDraft(request, new AbortController().signal), controller = new AbortController();
    await operation.registerExplicitSource(f.source);
    const finalizing = operationKind === 'finalize' ? draft.finalize(controller.signal)
      : draft.prompt({ op: 'export', copy_preset: 'manual', path: 'cancelled-manual.md', maxOutputBytes: 100000 }, controller.signal);
    await Promise.race([f.entering, finalizing.then(() => { throw new Error('Demand settled before extraction'); })]);
    const rejected = assert.rejects(finalizing, /abort|cancel/i);
    controller.abort(); f.release(); await rejected;
    assert.equal(draft.revision, 0); assert.deepEqual(draft.selectionProjection().sources, []);
    await assert.rejects(readFile(join(f.base, 'out/cancelled-manual/manifest.json')), /ENOENT/);
    await assert.rejects(readFile(join(f.base, 'out/cancelled-manual.md')), /ENOENT/);
  } finally { f.release(); await operation.close(); await f.runtime.close(); }
});

async function fixture(outcome: 'held' | 'failFirst' = 'held',
  beforeRead: ((request: Extract<NativeOperation, { kind: 'readSource' }>) => Promise<void>) | null = null, settings = copyContext()) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'smip-codemap-demand-')));
  const root = join(base, 'source'), output = join(base, 'out');
  await mkdir(join(root, 'private'), { recursive: true }); await mkdir(output);
  await writeFile(join(root, '.repo_ignore'), 'private/\n');
  await writeFile(join(root, 'private/Hidden.swift'), 'struct Hidden { let value: Int }\n');
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let extractions = 0;
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (operation.kind === 'readSource' && beforeRead) await beforeRead(operation);
          if (operation.kind === 'extract') {
            extractions++; entered(); await held;
            if (outcome === 'failFirst' && extractions === 1) throw new Error('Fixture extraction failed');
          }
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ copyContext: settings, cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const owner = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, new AbortController().signal);
  await owner.refresh(new AbortController().signal);
  return { base, runtime, owner, entering, release, source: { root: 'r', path: 'private/Hidden.swift' }, extractions: () => extractions };
}

test('workspace codemap demand shares extraction and releasing one request preserves another retainer', async () => {
  const f = await fixture();
  const first = await f.owner.openOperation(new AbortController().signal);
  const second = await f.owner.openOperation(new AbortController().signal);
  try {
    const one = await first.requestExplicitCodemap(f.source);
    const entering = Promise.race([f.entering, one.result.then(() => { throw new Error('Demand settled before extraction'); })]);
    await entering;
    const two = await second.requestExplicitCodemap(f.source);
    await one.release(); await first.close();
    assert.equal(f.extractions(), 1);
    f.release();
    const result = await two.result;
    assert.equal(result.structural.kind, 'artifact');
    if (result.structural.kind === 'artifact') assert.equal(result.structural.record.outcome.kind, 'ready');
    await two.release();
    await writeFile(join(f.base, 'shared-demand-receipt.json'), JSON.stringify({ extractions: f.extractions(), result }, null, 2) + '\n');
  } finally { f.release(); await first.close(); await second.close(); await f.owner.close(); await f.runtime.close(); }
});

test('last codemap retain release joins admitted extraction and a later request can use the durable artifact', async () => {
  const f = await fixture();
  const operation = await f.owner.openOperation(new AbortController().signal);
  try {
    const lease = await operation.requestExplicitCodemap(f.source);
    await Promise.race([f.entering, lease.result.then(() => { throw new Error('Demand settled before extraction'); })]);
    const rejected = assert.rejects(lease.result, /cancelled|aborted/i);
    let joined = false;
    const closing = lease.release().then(() => { joined = true; });
    await Promise.resolve(); assert.equal(joined, false);
    f.release(); await closing; await rejected;
    const registered = operation.snapshot.entries.find(entry => entry.root === f.source.root && entry.path === f.source.path);
    assert(registered?.kind === 'file'); assert.equal(registered.structural.kind, 'pending');
    const retry = await operation.requestExplicitCodemap(f.source);
    const result = await retry.result; await retry.release();
    assert.equal(result.structural.kind, 'artifact'); assert.equal(f.extractions(), 1);
    await writeFile(join(f.base, 'released-demand-receipt.json'), JSON.stringify({ registered, result, extractions: f.extractions() }, null, 2) + '\n');
  } finally { f.release(); await operation.close(); await f.owner.close(); await f.runtime.close(); }
});

test('failed native codemap demand releases its flight and a later request retries the same source', async () => {
  const f = await fixture('failFirst');
  const operation = await f.owner.openOperation(new AbortController().signal);
  try {
    const failed = await operation.requestExplicitCodemap(f.source);
    const rejected = assert.rejects(failed.result, /Fixture extraction failed/);
    f.release(); await rejected; await failed.release();
    const retry = await operation.requestExplicitCodemap(f.source);
    const result = await retry.result; await retry.release();
    assert.equal(result.structural.kind, 'artifact'); assert.equal(f.extractions(), 2);
    await writeFile(join(f.base, 'failed-demand-receipt.json'), JSON.stringify({ result, extractions: f.extractions() }, null, 2) + '\n');
  } finally { f.release(); await operation.close(); await f.owner.close(); await f.runtime.close(); }
});

test('a failed shared demand admits a fresh request before the previous retainer releases', async () => {
  await mkdir('test-output', { recursive: true });
  const f = await fixture('failFirst'), signal = new AbortController().signal;
  const first = await f.owner.openOperation(signal), joined = await f.owner.openOperation(signal), next = await f.owner.openOperation(signal);
  try {
    const original = await first.requestExplicitCodemap(f.source);
    const originalFailure = assert.rejects(original.result, /Fixture extraction failed/);
    await f.entering;
    const shared = await joined.requestExplicitCodemap(f.source);
    const sharedFailure = assert.rejects(shared.result, /Fixture extraction failed/);
    f.release(); await originalFailure; await sharedFailure;
    await shared.release(); await joined.close();
    const retry = await next.requestExplicitCodemap(f.source);
    await original.release(); await first.close();
    const result = await retry.result; await retry.release();
    assert.equal(f.extractions(), 2);
    assert.equal(result.structural.kind, 'artifact');
    if (result.structural.kind === 'artifact') assert.equal(result.structural.record.outcome.kind, 'ready');
    await writeFile('test-output/failed-shared-demand-retry-proof.json', JSON.stringify({ result, extractions: f.extractions() }, null, 2) + '\n');
  } finally { f.release(); await first.close(); await joined.close(); await next.close(); await f.owner.close(); await f.runtime.close(); }
});

test('source changes during extraction cannot publish a ready codemap into the managed catalog', async () => {
  await mkdir('test-output', { recursive: true });
  const f = await fixture();
  const operation = await f.owner.openOperation(new AbortController().signal);
  try {
    const lease = await operation.requestExplicitCodemap(f.source);
    await Promise.race([f.entering, lease.result.then(() => { throw new Error('Demand settled before extraction'); })]);
    await writeFile(join(f.base, 'source', f.source.path), 'struct Replaced { let title: String }\n');
    const rejected = assert.rejects(lease.result, /sourceChanged/);
    f.release(); await rejected; await lease.release();
    const registered = operation.snapshot.entries.find(entry => entry.root === f.source.root && entry.path === f.source.path);
    assert(registered?.kind === 'file'); assert.equal(registered.structural.kind, 'pending');
    await writeFile('test-output/stale-demand-proof.json', JSON.stringify({ registered, extractions: f.extractions() }, null, 2) + '\n');
  } finally { f.release(); await operation.close(); await f.owner.close(); await f.runtime.close(); }
});

test('runtime shutdown cancels and joins owned codemap demand before completing', async () => {
  const f = await fixture();
  const operation = await f.owner.openOperation(new AbortController().signal);
  try {
    const lease = await operation.requestExplicitCodemap(f.source);
    await Promise.race([f.entering, lease.result.then(() => { throw new Error('Demand settled before extraction'); })]);
    const rejected = assert.rejects(lease.result, /cancelled|aborted|nativeWorkerClosed/i);
    let joined = false;
    const closing = f.runtime.close().then(() => { joined = true; });
    await Promise.resolve(); assert.equal(joined, false);
    f.release(); await closing; await rejected; await lease.release();
    await writeFile(join(f.base, 'shutdown-demand-receipt.json'), JSON.stringify({ joined, extractions: f.extractions() }, null, 2) + '\n');
  } finally { f.release(); await operation.close(); await f.owner.close(); await f.runtime.close(); }
});

test('a readiness deadline releases only the reply observer while another demand retainer remains pending', async () => {
  await mkdir('test-output', { recursive: true });
  const sourceReadinessMilliseconds = referenceCases.find(entry => entry.name === 'ready-completion')!.waitMilliseconds;
  const reference = referenceCases.find(entry => entry.name === 'pending-deadline-with-independent-retainer')!;
  const f = await fixture(), signal = new AbortController().signal, client = f.runtime.createClient(null);
  const other = await f.owner.openOperation(signal);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: join(f.base, 'source') }], exclusions: [], outputRoot: join(f.base, 'out') }, signal);
    const draft = await client.createDraft(workspace.id, { task: 'Inspect', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      initialSelection: { codemapMode: 'manual', sources: [] }, requiredSources: [], documents: [], patches: [],
      duplicateUserInstructionsAtTop: false, copyPreset: 'standard', budgetUnits: 100000, discoveryHints: [], outputName: 'deadline-observer' }, signal);
    const retained = await other.requestExplicitCodemap(f.source);
    await f.entering;
    let releasedForFailure = false, underlyingComplete = false;
    void retained.result.then(() => { underlyingComplete = true; }, () => {});
    // Release the fixture after a second readiness window so the regressed join fails instead of hanging the suite.
    timer = setTimeout(() => { releasedForFailure = true; f.release(); }, 2 * sourceReadinessMilliseconds);
    const pending = await client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
      op: 'set', mode: 'codemap_only', paths: ['r/private/Hidden.swift'], view: 'content', maxOutputBytes: 30000,
    })), signal);
    assert.equal(releasedForFailure, false, 'A reply must not join another retainer after its readiness deadline');
    const underlyingCompleteBeforeReply = underlyingComplete;
    assert.equal(underlyingCompleteBeforeReply, reference.afterPresentationRelease[0]!.workCompleted);
    assert.equal(pending.revision, 1); assert.equal(pending.measurement.complete, false);
    assert.deepEqual(pending.code_structure?.pending_paths, ['private/Hidden.swift']);
    assert.deepEqual(pending.code_structure?.pending_paths?.map(() => 'pending'), reference.statuses);
    f.release();
    await retained.result; await retained.release();
    const completed = await client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
      op: 'get', view: 'content', maxOutputBytes: 30000,
    })), signal);
    assert.equal(completed.revision, 1); assert(completed.blocks?.some(block => block.includes('Hidden')));
    const finalized = await client.finalize(draft.id, signal); assert.equal(finalized.kind, 'ready');
    if (finalized.kind === 'ready') await verifyBundle(finalized.directory);
    await writeFile('test-output/codemap-readiness-observer-proof.json', JSON.stringify({ pending, completed, finalized,
      releasedForFailure, underlyingCompleteBeforeReply, extractions: f.extractions() }, null, 2) + '\n');
  } finally {
    if (timer !== null) clearTimeout(timer);
    f.release(); await other.close(); await client.close(); await f.owner.close(); await f.runtime.close();
  }
});

test('rendering an already-ready codemap may finish after the presentation readiness deadline', async () => {
  await mkdir('test-output', { recursive: true });
  const reference = referenceCases.find(entry => entry.name === 'ready-completion')!;
  const sourceReadinessMilliseconds = reference.waitMilliseconds;
  let armed = false, releaseRead!: () => void;
  const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
  const f = await fixture('held', async request => {
    if (armed && request.path === 'private/Hidden.swift') { armed = false; await heldRead; }
  });
  const signal = new AbortController().signal, client = f.runtime.createClient(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: join(f.base, 'source') }], exclusions: [], outputRoot: join(f.base, 'out') }, signal);
    const draft = await client.createDraft(workspace.id, { task: 'Inspect', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      initialSelection: { codemapMode: 'manual', sources: [] }, requiredSources: [], documents: [], patches: [],
      duplicateUserInstructionsAtTop: false, copyPreset: 'standard', budgetUnits: 100000, discoveryHints: [], outputName: 'ready-render' }, signal);
    f.release();
    await client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
      op: 'set', mode: 'codemap_only', paths: [join(f.base, 'source', f.source.path)], view: 'content', maxOutputBytes: 30000,
    })), signal);
    armed = true;
    timer = setTimeout(releaseRead, 2 * sourceReadinessMilliseconds);
    const completed = await client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
      op: 'get', view: 'content', maxOutputBytes: 30000,
    })), signal);
    assert.equal(armed, false); assert.equal(completed.revision, 1);
    assert.equal(completed.measurement.complete, true);
    assert.deepEqual(completed.files.map(() => 'ready'), reference.statuses);
    assert(completed.blocks?.some(block => block.includes('Hidden')));
    await writeFile('test-output/codemap-ready-render-proof.json', JSON.stringify({ completed }, null, 2) + '\n');
  } finally {
    if (timer !== null) clearTimeout(timer);
    releaseRead(); f.release(); await client.close(); await f.owner.close(); await f.runtime.close();
  }
});
