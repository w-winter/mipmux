import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { selectionValidator } from '../src/contracts/selection.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';

async function fixture(Runtime: typeof SmipRuntime = SmipRuntime) {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'smip-final-map-'));
  for (const name of ['r', 's', 'out']) await mkdir(join(directory, name));
  await writeFile(join(directory, 'r/Main.swift'), 'struct Main { let peer: Peer }\n');
  await writeFile(join(directory, 'r/Peer.swift'), 'struct Peer { let value: Int }\n');
  await writeFile(join(directory, 'r/Neighbor.swift'), 'struct Neighbor { let other: String }\n');
  await writeFile(join(directory, 's/Other.swift'), 'struct Other {}\n');
  const runtime = new Runtime({ copyContext: copyContext(), cachePath: join(directory, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = new AbortController().signal;
  const client = runtime.createClient(null);
  const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: join(directory, 'r') },
    { name: 's', absolutePath: join(directory, 's') }], exclusions: [], outputRoot: join(directory, 'out') }, signal);
  const draft = await client.createDraft(workspace.id, { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'preserve',
    purpose: 'investigation', requiredSources: [], documents: [], patches: [], budgetUnits: 100000,
    discoveryHints: [], outputName: 'packet' }, signal);
  return { directory, runtime, client, draft, signal };
}

test('final map uses export selection, native neighbors and operation-specific codemap markers', async () => {
  const f = await fixture();
  try {
    await f.client.update(f.draft.id, { expectedRevision: 0, maxOutputBytes: 30000,
      mutation: { kind: 'upsert', selection: { kind: 'full', source: { root: 'r', path: 'Main.swift' } } } }, f.signal);
    const costs = await f.client.inspect(f.draft.id, { view: 'costs', continuation: null, maxOutputBytes: 30000 }, new AbortController().signal);
    assert(costs.kind === 'costs');
    const result = await f.client.finalize(f.draft.id, f.signal);
    assert(result.kind === 'ready');
    const context = await readFile(join(result.directory, 'context.md'), 'utf8');
    const map = /^<file_map>\n([\s\S]*?)\n<\/file_map>\n/m.exec(context);
    assert(map, 'The final packet must contain the native file map');
    assert(map[1]!.includes('Main.swift * +'));
    assert(map[1]!.includes('Peer.swift * +'));
    assert(map[1]!.includes('Neighbor.swift\n'));
    assert(!map[1]!.includes('Neighbor.swift +'));
    assert(!map[1]!.includes('Other.swift'));
    assert.equal(costs.measurement.bytes, Buffer.byteLength(context));
    assert.equal(costs.measurement.units, result.manifest.accounting.units);
    const retained = await f.client.inspect(f.draft.id, { view: 'costs', continuation: null, maxOutputBytes: 30000 }, new AbortController().signal);
    assert.deepEqual(retained, { ...costs, state: 'terminal' });
    await verifyBundle(result.directory);
    await verifyCurrentBundle(result.directory, f.runtime, f.signal);
    await writeFile(join(f.directory, 'final-map-receipt.json'), JSON.stringify({ directory: result.directory, costs, map: map[1] }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});

for (const operation of ['renderFileTree', 'renderPreparedClipboard'] as const)
for (const boundary of ['cancellation', 'revision', 'freeze'] as const) test(`${operation} preparation cannot commit across ${boundary}`, async () => {
  let armed = false, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(input: O, signal: AbortSignal) {
          if (armed && input.kind === operation) { armed = false; entered(); await held; }
          return super.request(input, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const f = await fixture(Runtime), abort = new AbortController();
  try {
    armed = true;
    const work = f.client.update(f.draft.id, { expectedRevision: 0, maxOutputBytes: 30000,
      mutation: { kind: 'upsert', selection: { kind: 'full', source: { root: 'r', path: 'Main.swift' } } } }, abort.signal);
    const rejected = assert.rejects(work, boundary === 'cancellation' ? /cancelled|aborted|nativeWorkerClosed/i
      : boundary === 'revision' ? /revisionConflict/ : /draftFrozen|cancelled|aborted/i);
    await Promise.race([started, work.then(() => { throw new Error('Mutation did not prepare native presentation'); })]);
    if (boundary === 'cancellation') abort.abort();
    if (boundary === 'revision') await f.client.update(f.draft.id, { expectedRevision: 0, maxOutputBytes: 30000,
      mutation: { kind: 'prompt', op: 'append', text: ' changed' } }, f.signal);
    const finalizing = boundary === 'freeze' ? f.client.finalize(f.draft.id, f.signal) : null;
    release(); await rejected;
    if (finalizing) await finalizing;
    const state = await f.client.inspect(f.draft.id, { view: 'metadata', continuation: null, maxOutputBytes: 30000 }, new AbortController().signal);
    assert(state.kind === 'metadata');
    assert(!state.items.some(item => 'kind' in item && item.kind === 'source'));
    await writeFile(join(f.directory, 'map-preparation-receipt.json'), JSON.stringify({ boundary, state }, null, 2) + '\n');
  } finally { release(); await f.runtime.close(); }
});
