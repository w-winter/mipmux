import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, type ContextBuildRequest } from '../src/index.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { selectionValidator } from '../src/contracts/selection.js';

const peerBody = 'struct PeerRecord { let value: Int }\n';
const hiddenBody = 'struct HiddenRecord { let value: Int }\n';
const request: ContextBuildRequest = { task: 'Inspect', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
  initialSelection: { codemapMode: 'automatic', sources: [] }, requiredSources: [{ kind: 'full', source: { root: 'a', path: 'Seed.swift' } }],
  documents: [], patches: [], storedPrompts: [], duplicateUserInstructionsAtTop: false, copyPreset: 'standard', budgetUnits: 100000,
  discoveryHints: [], outputName: 'packet' };

async function fixture(before: (base: string, operation: NativeOperation) => Promise<void>, after: (base: string, operation: NativeOperation) => Promise<void>) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'smip-final-codemap-')));
  for (const name of ['a', 'b', 'out', 'a/private']) await mkdir(join(base, name));
  await writeFile(join(base, 'a/Seed.swift'), 'struct SeedRecord { let peer: PeerRecord }\n');
  await writeFile(join(base, 'a/Peer.swift'), peerBody);
  await writeFile(join(base, 'a/Empty.swift'), '');
  await writeFile(join(base, 'a/.repo_ignore'), 'private/\n');
  await writeFile(join(base, 'a/private/Hidden.swift'), hiddenBody);
  await writeFile(join(base, 'b/Healthy.swift'), 'struct HealthyRecord { let value: Int }\n');
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          await before(base, operation);
          const reply = await super.request(operation, signal);
          await after(base, operation);
          return reply;
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = new AbortController().signal, client = runtime.createClient(null);
  const workspace = await client.declare({ roots: [{ name: 'a', absolutePath: join(base, 'a') }, { name: 'b', absolutePath: join(base, 'b') }],
    exclusions: [], outputRoot: join(base, 'out') }, signal);
  return { base, runtime, client, workspace, signal };
}

test('finalization freshly applies root rendering before publication without requiring a selection get', async () => {
  const f = await fixture(async () => {}, async () => {});
  try {
    const draft = await f.client.createDraft(f.workspace.id, { ...request, initialSelection: { codemapMode: 'manual', sources: [
      { kind: 'codemap', source: { root: 'a', path: 'Peer.swift' } }, { kind: 'codemap', source: { root: 'a', path: 'Empty.swift' } },
      { kind: 'codemap', source: { root: 'b', path: 'Healthy.swift' } },
    ] } }, f.signal);
    const ready = await f.client.finalize(draft.id, f.signal); assert.equal(ready.kind, 'ready');
    if (ready.kind === 'ready') {
      await verifyBundle(ready.directory);
      assert(ready.manifest.unavailableFiles.some(file => file.code === 'codemapPending' && file.selection.source.path === 'Peer.swift'));
      const content = await readFile(join(ready.directory, 'context.md'), 'utf8');
      assert(content.includes('SeedRecord')); assert(content.includes('HealthyRecord'));
      assert(!ready.manifest.materials.some(record => record.kind === 'source' && record.selection.kind === 'codemap' &&
        record.selection.source.path === 'Peer.swift'));
    }
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/final-codemap-root-proof.json', JSON.stringify({ ready }, null, 2) + '\n');
  } finally { await f.client.close(); await f.runtime.close(); }
});

test('finalization reacquires an explicit presentation from durable completed work after its observer cancelled', async () => {
  let entered!: () => void, release!: () => void, extractions = 0;
  const entering = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async (_base, operation) => {
    if (operation.kind === 'extract' && operation.bytes === Buffer.from(hiddenBody).toString('base64')) { extractions++; entered(); await held; }
  }, async () => {});
  const abort = new AbortController();
  try {
    const draft = await f.client.createDraft(f.workspace.id, { ...request, initialSelection: { codemapMode: 'manual', sources: [] } }, f.signal);
    const work = f.client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
      op: 'add', mode: 'codemap_only', paths: [join(f.base, 'a/private/Hidden.swift')], maxOutputBytes: 30000,
    })), abort.signal);
    const rejected = assert.rejects(work, /cancelled|aborted|nativeWorkerClosed/i);
    await Promise.race([entering, work.then(() => { throw new Error('Extraction was not held'); })]);
    abort.abort(); release(); await rejected;
    const ready = await f.client.finalize(draft.id, f.signal); assert.equal(ready.kind, 'ready');
    if (ready.kind === 'ready') {
      const bundle = await verifyBundle(ready.directory);
      assert(bundle.manifest.materials.some(record => record.kind === 'source' && record.selection.source.path === 'private/Hidden.swift'));
    }
    assert.equal(extractions, 1);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/final-codemap-cancelled-observer-proof.json', JSON.stringify({ ready, extractions }, null, 2) + '\n');
  } finally { release(); await f.client.close(); await f.runtime.close(); }
});

test('finalization refreshes automatic acquisition rather than publishing an obsolete unavailable observation', async () => {
  let fail = true;
  const f = await fixture(async (_base, operation) => {
    if (fail && operation.kind === 'readSource' && operation.path === 'Peer.swift' && operation.expected !== null) {
      fail = false; throw new NativeFailure('sourceChanged', null);
    }
  }, async () => {});
  try {
    const draft = await f.client.createDraft(f.workspace.id, request, f.signal);
    const ready = await f.client.finalize(draft.id, f.signal); assert.equal(ready.kind, 'ready');
    if (ready.kind === 'ready') {
      const bundle = await verifyBundle(ready.directory);
      assert(bundle.manifest.materials.some(record => record.kind === 'source' && record.selectionOrigin === 'inferred' && record.selection.source.path === 'Peer.swift'));
      assert(bundle.manifest.automaticCodemaps.every(item => item.outcome.kind === 'ready'));
    }
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/final-codemap-automatic-refresh-proof.json', JSON.stringify({ ready }, null, 2) + '\n');
  } finally { await f.client.close(); await f.runtime.close(); }
});

test('stale clipboard assembly is discarded before candidate output is written and can be retried after recovery', async () => {
  let armed = false;
  const f = await fixture(async () => {}, async (base, operation) => {
    if (armed && operation.kind === 'renderPreparedClipboard') {
      armed = false; await writeFile(join(base, 'a/Peer.swift'), 'struct ChangedRecord { let flag: Bool }\n');
    }
  });
  try {
    const draft = await f.client.createDraft(f.workspace.id, request, f.signal); armed = true;
    const blocked = await f.client.finalize(draft.id, f.signal); assert.equal(blocked.kind, 'blocked');
    assert.deepEqual(await readdir(join(f.base, 'out')), []);
    await writeFile(join(f.base, 'a/Peer.swift'), peerBody);
    const ready = await f.client.finalize(draft.id, f.signal); assert.equal(ready.kind, 'ready');
    if (ready.kind === 'ready') {
      await verifyBundle(ready.directory);
      assert((await readFile(join(ready.directory, 'context.md'), 'utf8')).includes('PeerRecord'));
    }
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/final-codemap-stale-assembly-proof.json', JSON.stringify({ blocked, ready }, null, 2) + '\n');
  } finally { await f.client.close(); await f.runtime.close(); }
});
