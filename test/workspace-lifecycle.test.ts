import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { MipmuxRuntime, type RuntimeOptions } from '../src/runtime/mipmux-runtime.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import type { WorkspaceSpec } from '../src/contracts/inventory.js';
import type { DiscoveryRunner } from '../src/discovery/runner.js';
import { WorkspaceFailure } from '../src/workspace/values.js';
import { fixtureSettings } from './fixtures/discovery-settings.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

setFlagsFromString('--expose-gc');
// SAFETY: once --expose-gc is set, a new context's global `gc` is V8's full collector, which takes no arguments.
const collectGarbage = runInNewContext('gc') as () => void;

test('closed workspaces release their inventories and their output roots\' snapshot helpers', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-release-'));
  const root = join(base, 'root'); await mkdir(root);
  await writeFile(join(root, 'model.swift'), 'struct Model {}\n');
  const open = new Set<BridgeClient>();
  const options: RuntimeOptions = { copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } };
  class CountingRuntime extends MipmuxRuntime {
    override makeBridge() {
      const bridge = super.makeBridge();
      open.add(bridge); void bridge.closed.then(() => open.delete(bridge));
      return bridge;
    }
  }
  const runtime = new CountingRuntime(options), signal = new AbortController().signal;
  try {
    const client = runtime.createClient(null);
    const inventories: WeakRef<object>[] = [];
    for (const run of ['a', 'b']) {
      const outputRoot = join(base, 'out-' + run); await mkdir(outputRoot);
      const { id } = await client.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot }, signal);
      inventories.push(new WeakRef(await client.refresh(id, signal)));
      await client.closeWorkspace(id);
      await assert.rejects(client.refresh(id, signal), /workspaceClosed/);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(open.size, 0, 'a closed workspace left a native helper running');
    collectGarbage();
    assert(inventories.every(inventory => inventory.deref() === undefined), 'a closed workspace kept its inventory');
    await client.close();
  } finally { await runtime.close(); }
});

test('inline calls share admission, retain a warm workspace and join it on close', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-inline-workspace-'));
  const root = join(base, 'root'), out = join(base, 'out'), otherOut = join(base, 'other-out');
  await mkdir(root); await mkdir(out); await mkdir(otherOut);
  await writeFile(join(root, 'model.swift'), 'struct Model {\n let value: String\n}');
  const open = new Set<BridgeClient>();
  let hold: { readonly entered: ReturnType<typeof barrier>; readonly resume: ReturnType<typeof barrier> } | null = null;
  let declarations = 0;
  const options: RuntimeOptions = { copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000,
    credentialPaths: [], nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {} };
  class ObservedRuntime extends MipmuxRuntime {
    override declare(spec: WorkspaceSpec, signal: AbortSignal) { declarations++; return super.declare(spec, signal); }
    override makeBridge() {
      class ObservedBridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          // Workspace admission is the only source-root opening without an expected identity.
          const held = hold;
          if (held && operation.kind === 'openRoots' && operation.roots[0]?.access === 'source' && operation.roots[0].expected === null) {
            hold = null; held.entered.release(); await held.resume.promise;
          }
          return super.request(operation, signal);
        }
      }
      const bridge = new ObservedBridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
      open.add(bridge); void bridge.closed.then(() => open.delete(bridge));
      return bridge;
    }
  }
  const runner: DiscoveryRunner = { settings: fixtureSettings, run: () => Promise.reject(new WorkspaceFailure('fixtureDiscoveryStopped')) };
  const runtime = new ObservedRuntime(options), signal = new AbortController().signal;
  const settled = () => new Promise(resolve => setImmediate(resolve));
  const request = (outputName: string, outputRoot = out) => ({ workspace: { roots: [{ name: 'r', absolutePath: root }], outputRoot },
    purpose: 'investigation' as const, task: 'Inspect the model', outputName });
  const first = { entered: barrier(), resume: barrier() }, closing = { entered: barrier(), resume: barrier() };
  try {
    const client = runtime.createClient(runner);
    hold = first;
    const cancelled = new AbortController();
    const abandoned = client.buildContext(request('run-a'), cancelled.signal);
    const refused = assert.rejects(abandoned, /cancelled/);
    await first.entered.promise;
    const shared = client.buildContext(request('run-b'), signal);
    cancelled.abort(); await refused;
    first.resume.release();
    const job = await shared;
    assert.equal((await client.wait(job.jobId, 10000, signal, () => {})).state, 'failed');
    await settled();
    const retained = open.size;
    assert(retained > 0, 'the inline workspace released its warm owner');
    for (const outputName of ['run-c', 'run-d']) {
      const repeated = await client.buildContext(request(outputName), signal);
      assert.equal((await client.wait(repeated.jobId, 10000, signal, () => {})).state, 'failed');
    }
    await settled();
    assert.equal(declarations, 1); assert.equal(open.size, retained);

    hold = closing;
    const pending = client.buildContext(request('run-e', otherOut), signal);
    const rejected = assert.rejects(pending, /cancelled|clientClosed/);
    await closing.entered.promise;
    const closed = client.close();
    closing.resume.release();
    await rejected; await closed; await settled();
    assert.equal(declarations, 2);
    assert.equal(open.size, 0, 'a closed client left a native helper running');
  } finally { first.resume.release(); closing.resume.release(); await runtime.close(); }
});

test('warming satisfies a later barrier, cancelled observers release only their interest, and caches survive restart', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-barrier-'));
  const root = join(base, 'root'); await mkdir(root); await mkdir(join(base, 'out'));
  await writeFile(join(root, 'model.swift'), 'struct First {\n let value: String\n}');
  const entered = barrier(), resume = barrier();
  let blocked = false, extractions = 0;
  const options: RuntimeOptions = { copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } };
  class ObservedRuntime extends MipmuxRuntime {
    override makeBridge() {
      class ObservedBridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          const reply = await super.request(operation, signal);
          if (operation.kind === 'extract') extractions++;
          if (operation.kind === 'readSource' && operation.path === 'model.swift' && !blocked) {
            blocked = true; entered.release(); await resume.promise;
          }
          return reply;
        }
      }
      return new ObservedBridge({ executable: options.nativeExecutable, env: options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: join(base, 'out') };
  const runtime = new ObservedRuntime(options);
  try {
    const handle = await runtime.declare(spec, new AbortController().signal);
    await entered.promise;
    await writeFile(join(root, 'model.swift'), 'struct Other {\n let value: String\n}');
    const cancelled = new AbortController();
    const observer = handle.refresh(cancelled.signal);
    const refused = assert.rejects(observer, /cancelled/);
    cancelled.abort(); await refused;
    const later = handle.refresh(new AbortController().signal);
    resume.release();
    const snapshot = await later;
    assert.equal(extractions, 2);
    const operation = await handle.openOperation(new AbortController().signal);
    assert.match((await operation.readSource({ root: 'r', path: 'model.swift' })).bytes.toString(), /Other/);
    await unlink(join(root, 'model.swift'));
    const deleted = await handle.refresh(new AbortController().signal);
    assert(!deleted.entries.some(entry => entry.kind === 'file'));
    assert.notEqual(deleted.inventoryDigest, snapshot.inventoryDigest);
    await writeFile(join(root, 'model.swift'), 'struct Other {\n let value: String\n}');
    await handle.refresh(new AbortController().signal);
    assert.equal(extractions, 2);
    await handle.close();
    assert.match((await operation.readSource({ root: 'r', path: 'model.swift' })).bytes.toString(), /Other/);
    await operation.close();
  } finally { resume.release(); await runtime.close(); }
  const restarted = new ObservedRuntime(options);
  try {
    const handle = await restarted.declare(spec, new AbortController().signal);
    await handle.refresh(new AbortController().signal);
    assert.equal(extractions, 2);
    await handle.close();
  } finally { await restarted.close(); }
});

test('different declarations share pending extraction while public and operation leases close independently', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-shared-'));
  await mkdir(join(base, 'root')); await mkdir(join(base, 'outA')); await mkdir(join(base, 'outB'));
  await writeFile(join(base, 'root/shared.swift'), 'struct SharedRecord {\n let value: String\n}');
  const extractionEntered = barrier(), releaseExtraction = barrier(), secondRead = barrier();
  let extractions = 0, reads = 0;
  const options: RuntimeOptions = { copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } };
  class ObservedRuntime extends MipmuxRuntime {
    override makeBridge() {
      class ObservedBridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (operation.kind === 'extract') { extractions++; extractionEntered.release(); await releaseExtraction.promise; }
          const reply = await super.request(operation, signal);
          if (operation.kind === 'readSource' && operation.path === 'shared.swift' && ++reads === 2) secondRead.release();
          return reply;
        }
      }
      return new ObservedBridge({ executable: options.nativeExecutable, env: options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new ObservedRuntime(options);
  const spec = { roots: [{ name: 'r', absolutePath: join(base, 'root') }], exclusions: [], outputRoot: join(base, 'outA') };
  try {
    const a = await runtime.declare(spec, new AbortController().signal);
    await extractionEntered.promise;
    const b = await runtime.declare({ ...spec, outputRoot: join(base, 'outB') }, new AbortController().signal);
    await secondRead.promise;
    await a.close(); releaseExtraction.release();
    await b.refresh(new AbortController().signal);
    assert.equal(extractions, 1);
    const cancelled = new AbortController();
    const opA = await b.openOperation(cancelled.signal), opB = await b.openOperation(new AbortController().signal);
    cancelled.abort(); await assert.rejects(opA.readSource({ root: 'r', path: 'shared.swift' }), /cancelled/);
    await b.close();
    assert.match((await opB.readSource({ root: 'r', path: 'shared.swift' })).bytes.toString(), /SharedRecord/);
    await opA.close(); await opB.close();
  } finally { releaseExtraction.release(); await runtime.close(); }
});

test('settled inventory distinguishes unavailable acquisition, decoding, unsupported and no-symbol outcomes', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-coverage-'));
  await mkdir(join(base, 'root/cases'), { recursive: true }); await mkdir(join(base, 'out'));
  await writeFile(join(base, 'root/cases/victim.swift'), 'struct Victim {\n let value: String\n}');
  await writeFile(join(base, 'root/cases/invalid.swift'), Buffer.from([0xff, 0xfe, 0x00, 0xd8]));
  await writeFile(join(base, 'root/cases/empty.swift'), '');
  await writeFile(join(base, 'root/cases/note.txt'), 'unsupported');
  const options: RuntimeOptions = { copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } };
  class ObservedRuntime extends MipmuxRuntime {
    override makeBridge() {
      class ObservedBridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (operation.kind === 'readSource' && operation.path === 'cases/victim.swift') await unlink(join(base, 'root/cases/victim.swift'));
          return super.request(operation, signal);
        }
      }
      return new ObservedBridge({ executable: options.nativeExecutable, env: options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new ObservedRuntime(options);
  try {
    const handle = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(base, 'root') }], exclusions: [], outputRoot: join(base, 'out') }, new AbortController().signal);
    const operation = await handle.openOperation(new AbortController().signal);
    assert.equal(operation.snapshot.enumeration.kind, 'complete'); assert.equal(operation.snapshot.processing, 'settled');
    const result = await operation.getCodeStructure({ seeds: [{ kind: 'directory', root: 'r', directory: { kind: 'descendant', path: 'cases' } }], expand: 'none', depth: 1,
      signatures: false, size: 'medium', maxOutputBytes: 10000, selection: null });
    if (result.kind !== 'structure') assert.fail('Missing structures');
    assert.deepEqual(result.roots[0]?.seeds.map(seed => seed.state).sort(), ['pending', 'not_indexed', 'covered', 'not_indexed'].sort());
    assert.equal(result.roots[0]?.index.total, 3);
    assert.equal(result.roots[0]?.index.indexed, 2);
    assert.equal(result.roots[0]?.index.state, 'indexing');
    await operation.close(); await handle.close();
  } finally { await runtime.close(); }
});

test('closing a held physical operation joins pending work and leaves a sibling usable', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-operation-close-'));
  await mkdir(join(base, 'root')); await mkdir(join(base, 'out'));
  await writeFile(join(base, 'root/file.txt'), 'sibling body');
  const entered = barrier(), resume = barrier(), aborted = barrier();
  let hold = false;
  const options: RuntimeOptions = { copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {} };
  class Runtime extends MipmuxRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (hold && operation.kind === 'readSource' && operation.path === 'file.txt') {
            hold = false; signal.addEventListener('abort', aborted.release, { once: true });
            entered.release(); await resume.promise;
          }
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime(options);
  try {
    const handle = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(base, 'root') }], exclusions: [], outputRoot: join(base, 'out') }, new AbortController().signal);
    const a = await handle.openOperation(new AbortController().signal), b = await handle.openOperation(new AbortController().signal);
    hold = true;
    const read = a.readSource({ root: 'r', path: 'file.txt' }), rejected = assert.rejects(read);
    await entered.promise;
    let closed = false;
    const closing = a.close().then(() => { closed = true; });
    await aborted.promise;
    assert.equal(closed, false);
    assert.equal((await b.readSource({ root: 'r', path: 'file.txt' })).bytes.toString(), 'sibling body');
    resume.release(); await rejected; await closing;
    await b.close(); await handle.close();
  } finally { resume.release(); await runtime.close(); }
});

test('incomplete enumeration permits known-source exploration but refuses draft admission', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-partial-inventory-'));
  const root = join(base, 'root'), output = join(base, 'out');
  await mkdir(join(root, 'blocked'), { recursive: true }); await mkdir(output);
  await writeFile(join(root, 'known.swift'), 'struct KnownRecord {\n let absent: AbsentRecord\n}\n');
  class PartialRuntime extends MipmuxRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (operation.kind === 'walkDirectory' && operation.directory.kind === 'descendant' && operation.directory.path === 'blocked') {
            return Promise.reject(new NativeFailure('permissionDenied', null));
          }
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: {}, supervisor: this.supervisor });
    }
  }
  const runtime = new PartialRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 1000000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, credentialPaths: [] });
  const signal = new AbortController().signal;
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, signal);
    const operation = await workspace.openOperation(signal);
    try {
      const result = await operation.getCodeStructure({ seeds: [{ kind: 'file', root: 'r', path: 'known.swift' }],
        expand: 'uses', depth: 1, signatures: false, size: 'small', maxOutputBytes: 20000, selection: null });
      assert(result.kind === 'structure'); assert.equal(result.status, 'partial');
      assert.equal(result.roots[0]?.index.state, 'indexing');
      assert.equal(result.roots[0]?.unresolved[0]?.reason, 'not_indexed_yet');
      await assert.rejects(workspace.createDraft({ task: 'Inspect known source.', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', enhancementMode: 'preserve',
        purpose: 'investigation', requiredSources: [], documents: [], patches: [], discoveryHints: [], outputName: 'partial',
        budgetUnits: 100000 }, signal), /enumerationIncomplete/);
      await writeFile(join(base, 'partial-inventory-proof.json'), JSON.stringify(result, null, 2) + '\n');
    } finally { await operation.close(); await workspace.close(); }
  } finally { await runtime.close(); }
});
