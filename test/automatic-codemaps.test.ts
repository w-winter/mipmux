import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle, type ContextBuildRequest, type DraftRuntime } from '../src/index.js';
import { codemapRepresentation, identity, sourceId } from '../src/context/material-store.js';
import { loadVerifiedBundle } from '../src/context/verify.js';
import { renderBundle } from '../src/context/render.js';
import { prepareClipboard } from '../src/context/clipboard.js';
import { finalFileTreeInput } from '../src/context/final-tree.js';
import { canonicalJSON } from '../src/workspace/values.js';
import { inventoryDigest } from '../src/workspace/artifact-store.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { selectionValidator } from '../src/contracts/selection.js';
import { failureCode } from '../src/runtime/tool-result.js';

const signal = () => new AbortController().signal;
const maxOutputBytes = 100000;
const request: ContextBuildRequest = {
  task: 'Inspect the selected implementation and its dependencies', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation',
  requiredSources: [], documents: [], patches: [], discoveryHints: [], outputName: 'packet',
  budgetUnits: 100000,
};
const seed = { root: 'r', path: 'Seed.swift' };
const fullSeed = { kind: 'full' as const, source: seed };
const handoff = { clarifiedTask: 'Inspect the graph', architecture: 'Seed references peer and shared types',
  relationships: ['SeedRecord uses PeerRecord and SharedRecord'], ambiguities: [] };

async function fixture(beforeRead?: (path: string, pinned: boolean) => Promise<void>) {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'smip-automatic-codemaps-'));
  for (const name of ['r', 's', 'out']) await mkdir(join(directory, name));
  const files = {
    'Seed.swift': 'struct SeedRecord {\n let peer: PeerRecord\n let shared: SharedRecord\n let missing: MissingRecord\n}\n',
    'Peer.swift': 'struct PeerRecord {\n let leaf: LeafRecord\n}\n',
    'SharedA.swift': 'struct SharedRecord {\n let value: String\n}\n',
    'SharedB.swift': 'struct SharedRecord {\n let count: Int\n}\n',
    'Leaf.swift': 'struct LeafRecord {\n let value: String\n}\n',
    'User.swift': 'struct UserRecord {\n let seed: SeedRecord\n}\n',
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(directory, 'r', name), text);
  await writeFile(join(directory, 's/Peer.swift'), 'struct PeerRecord {\n let other: String\n}\n');
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (operation.kind === 'readSource') await beforeRead?.(operation.path, operation.expected !== null);
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, supervisor: this.supervisor, env: this.options.nativeEnvironment });
    }
  }
  const runtime = new Runtime({ cachePath: join(directory, 'cache'), contextBudgetUnits: 100000,
    credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {} });
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(directory, 'r') },
    { name: 's', absolutePath: join(directory, 's') }], exclusions: [], outputRoot: join(directory, 'out') }, signal());
  return { directory, runtime, workspace, files };
}

async function sources(draft: DraftRuntime) {
  const inspection = (await draft.inspect({ view: 'metadata', maxOutputBytes, continuation: null }, new AbortController().signal));
  assert(inspection.kind === 'metadata'); assert.equal(inspection.truncated, false);
  return inspection.items.flatMap(item => 'kind' in item && item.kind === 'source' ? [item] : []);
}

test('required admission and full upsert include one-hop root-local related codemaps', async t => {
  for (const admission of [true, false]) await t.test(admission ? 'required admission' : 'upsert', async () => {
    const f = await fixture();
    try {
      const draft = await f.workspace.createDraft({ ...request, requiredSources: admission ? [fullSeed] : [] }, signal());
      if (!admission) await draft.update({ expectedRevision: 0, maxOutputBytes,
        mutation: { kind: 'upsert', selection: fullSeed } }, signal());
      const selected = (await sources(draft));
      assert.deepEqual(selected.map(item => item.selection.source.root + '/' + item.selection.source.path).sort(),
        ['r/Peer.swift', 'r/Seed.swift', 'r/SharedA.swift', 'r/SharedB.swift']);
      for (const item of selected) assert.equal(item.selection.kind, item.selection.source.path === seed.path ? 'full' : 'codemap');
      assert.equal(draft.revision, admission ? 0 : 1);
      const initial = await draft.initialContext(signal()), block = initial.match(/^(`{3,})\n([\s\S]*?)\n\1\n/m); assert(block);
      const metadata: unknown = JSON.parse(block[2]!);
      assert(Compile(Type.Object({ inferredCodemaps: Type.Object({ count: Type.Literal(3), itemUnits: Type.Number({ minimum: 1 }) }),
        explicitSources: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 1 }) })).Check(metadata));
      assert(!block[2]!.includes('SharedA.swift'));
      await writeFile(join(f.directory, 'membership-proof.json'), JSON.stringify({ admission, selected }, null, 2));
      if (admission) {
        await draft.update({ expectedRevision: draft.revision, maxOutputBytes, mutation: { kind: 'clearCodemaps' } }, signal());
        assert.equal((await sources(draft)).length, 1);
        const reset = await draft.update({ expectedRevision: draft.revision, maxOutputBytes, mutation: { kind: 'clearSources' } }, signal());
        assert.equal(reset.codemapMode, 'automatic');
        assert.deepEqual((await sources(draft)).map(item => item.id).sort(), selected.map(item => item.id).sort());
        assert.equal((await sources(draft)).filter(item => item.selectionOrigin === 'inferred').length, 3);
      }
    } finally { await f.runtime.close(); }
  });
});

test('promotion, inferred removal and manual clear operations preserve intent and report real delivered costs', async () => {
  const f = await fixture();
  try {
    const draft = await f.workspace.createDraft(request, signal());
    const update = (mutation: Parameters<DraftRuntime['update']>[0]['mutation']) =>
      draft.update({ expectedRevision: draft.revision, maxOutputBytes, mutation }, signal());
    const added = await update({ kind: 'upsert', selection: fullSeed });
    assert.equal(added.changedCosts.length, 4);
    const before = (await draft.inspect({ view: 'metadata', maxOutputBytes, continuation: null }, new AbortController().signal));
    const absent = await update({ kind: 'remove', source: { root: 'r', path: 'absent.swift' } });
    const inferred = await update({ kind: 'remove', source: { root: 'r', path: 'Peer.swift' } });
    assert.equal(absent.revision, added.revision); assert.deepEqual(absent.changedCosts, []);
    assert.equal(inferred.revision, added.revision); assert.deepEqual(inferred.changedCosts, []);
    assert.deepEqual((await draft.inspect({ view: 'metadata', maxOutputBytes, continuation: null }, new AbortController().signal)), before);
    const peer = { root: 'r', path: 'Peer.swift' };
    await update({ kind: 'upsert', selection: { kind: 'slices', source: peer,
      ranges: [{ start: 1, end: 3, description: 'PeerRecord delegates to LeafRecord' }] } });
    assert((await sources(draft)).some(item => item.selection.source.path === 'Leaf.swift'));
    const removed = await update({ kind: 'remove', source: peer });
    assert(removed.changedCosts.find(item => item.id === sourceId(peer))!.units > 0);
    assert.equal(removed.changedCosts.find(item => item.id === sourceId({ root: 'r', path: 'Leaf.swift' }))!.units, 0);
    assert.equal((await sources(draft)).find(item => item.selection.source.path === peer.path)!.selectionOrigin, 'inferred');
    await update({ kind: 'upsert', selection: { kind: 'codemap', source: { root: 'r', path: 'SharedA.swift' } } });
    assert(!(await sources(draft)).some(item => item.selectionOrigin === 'inferred'));
    await update({ kind: 'upsert', selection: { kind: 'full', source: peer } });
    assert(!(await sources(draft)).some(item => item.selection.source.path === 'Leaf.swift'));
    const cleared = await update({ kind: 'clearCodemaps' }); assert.equal(cleared.codemapMode, 'manual');
    assert((await sources(draft)).every(item => item.selection.kind !== 'codemap'));
    const reset = await update({ kind: 'clearSources' }); assert.equal(reset.codemapMode, 'automatic');
    assert.deepEqual((await sources(draft)), []);
    await update({ kind: 'upsert', selection: fullSeed });
    await writeFile(join(f.directory, 'mutation-proof.json'), JSON.stringify({ added, absent, inferred, removed, cleared, reset,
      final: (await draft.inspect({ view: 'metadata', maxOutputBytes, continuation: null }, new AbortController().signal)) }, null, 2));
  } finally { await f.runtime.close(); }
});

test('required codemap intent stays manual and clear operations preserve all required material and handoff', async () => {
  const f = await fixture();
  try {
    const draft = await f.workspace.createDraft({ ...request, requiredSources: [fullSeed,
      { kind: 'codemap', source: { root: 'r', path: 'SharedA.swift' } }],
      documents: [{ kind: 'suppliedDocument', id: 'evidence', role: 'evidence', origin: 'fixture', text: 'Required evidence' }] }, signal());
    const update = (mutation: Parameters<DraftRuntime['update']>[0]['mutation']) =>
      draft.update({ expectedRevision: draft.revision, maxOutputBytes, mutation }, signal());
    const initial = (await draft.inspect({ view: 'metadata', maxOutputBytes, continuation: null }, new AbortController().signal));
    assert(initial.kind === 'metadata'); assert.equal(initial.codemapMode, 'manual');
    await update({ kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) });
    await update({ kind: 'upsert', selection: { kind: 'full', source: { root: 'r', path: 'Peer.swift' } } });
    assert(!(await sources(draft)).some(item => item.selection.source.path === 'Leaf.swift'));
    await update({ kind: 'clearCodemaps' }); await update({ kind: 'clearSources' });
    assert.equal((await sources(draft)).length, 2); assert((await sources(draft)).every(item => item.required));
    await assert.rejects(update({ kind: 'remove', source: seed }), /requiredMaterialMutation/);
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    assert.equal(ready.manifest.codemapMode, 'manual');
    assert.equal(ready.manifest.materials.filter(item => item.kind === 'document').length, 1);
    assert.equal(ready.manifest.prompt, request.task + '\n\n' + JSON.stringify(handoff)); await verifyBundle(ready.directory);
  } finally { await f.runtime.close(); }
});

test('inferred bodies publish and verify, while consistently rehashed missing membership is rejected', async () => {
  const f = await fixture();
  try {
    const draft = await f.workspace.createDraft({ ...request, requiredSources: [fullSeed] }, signal());
    await draft.update({ expectedRevision: 0, maxOutputBytes, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) } }, signal());
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    assert.equal(ready.manifest.schemaVersion, 15);
    assert.equal(ready.manifest.codemapMode, 'automatic');
    await verifyCurrentBundle(ready.directory, f.runtime, signal());
    const saved = await loadVerifiedBundle(ready.directory);
    const bytes = await readFile(join(ready.directory, 'context.md'));
    const source = ready.manifest.materials.find(item => item.kind === 'source' && item.selection.source.path === seed.path);
    assert(source?.kind === 'source'); assert.equal(source.selectionOrigin, 'explicit');
    const span = source.spans[0]!; assert.equal(bytes.subarray(span.offset, span.offset + span.length).toString(), f.files['Seed.swift']);
    assert.equal(ready.manifest.materials.filter(item => item.kind === 'source' && item.selectionOrigin === 'inferred').length, 3);
    for (const scenario of ['missing', 'manual', 'unrelated', 'explicit-codemap'] as const) {
      const manifest = structuredClone(ready.manifest);
      const materials = scenario === 'missing' ? saved.materials.filter(item => item.record.kind !== 'source' || item.record.selection.source.path !== 'SharedB.swift') : saved.materials.slice();
      if (scenario === 'manual') manifest.codemapMode = 'manual';
      if (scenario === 'unrelated' || scenario === 'explicit-codemap') {
        const template = materials.find(item => item.record.kind === 'source' && item.record.selectionOrigin === 'inferred');
        assert(template?.record.kind === 'source' && template.record.selectionOrigin === 'inferred');
        if (scenario === 'explicit-codemap') {
          materials[materials.indexOf(template)] = { ...template, record: { ...template.record, selectionOrigin: 'explicit' } };
        } else {
          const unrelated = manifest.inventory.entries.find(entry => entry.root === 'r' && entry.path === 'Leaf.swift');
          assert(unrelated?.kind === 'file');
          const source = { root: unrelated.root, path: unrelated.path }, representation = codemapRepresentation(unrelated, source);
          assert(representation?.kind === 'rendered');
          materials.push({ availability: 'settled', sourceBlock: null, record: { ...template.record, id: sourceId(source), selection: { kind: 'codemap', source },
            identity: unrelated.identity, artifactKey: representation.key }, bodies: [representation.body] });
        }
      }
      const rendered = renderBundle(await prepareClipboard(f.runtime, { request: manifest.request, inventory: manifest.inventory, prompt: manifest.prompt,
        automaticAcquisition: { kind: 'settled', outcomes: manifest.automaticCodemaps },
        codemapMode: manifest.codemapMode, materials,
        fileTree: { input: finalFileTreeInput(manifest.inventory, materials, manifest.codemapMode), text: saved.fileTree.text } }, signal()));
      manifest.fileTree = { input: finalFileTreeInput(manifest.inventory, materials, manifest.codemapMode), span: rendered.fileTreeSpan };
      manifest.materials = rendered.records; manifest.files = { context: identity(rendered.context), handoff: identity(rendered.handoff) };
      manifest.accounting.bytes = rendered.measurement.bytes; manifest.accounting.units = rendered.measurement.units;
      await writeFile(join(ready.directory, 'context.md'), rendered.context); await writeFile(join(ready.directory, 'handoff.md'), rendered.handoff);
      await writeFile(join(ready.directory, 'manifest.json'), canonicalJSON(manifest));
      await assert.rejects(verifyBundle(ready.directory), /bundleIntegrityFailed/);
    }
    const restored = renderBundle(await prepareClipboard(f.runtime, { request: ready.manifest.request, inventory: ready.manifest.inventory,
      automaticAcquisition: { kind: 'settled', outcomes: ready.manifest.automaticCodemaps },
      prompt: ready.manifest.prompt, codemapMode: ready.manifest.codemapMode, materials: saved.materials, fileTree: saved.fileTree }, signal()));
    await writeFile(join(ready.directory, 'context.md'), restored.context); await writeFile(join(ready.directory, 'handoff.md'), restored.handoff);
    await writeFile(join(ready.directory, 'manifest.json'), canonicalJSON(ready.manifest));
    await writeFile(join(f.directory, 'r/User.swift'), 'struct SharedRecord {}\n');
    await verifyCurrentBundle(ready.directory, f.runtime, signal());
    await writeFile(join(f.directory, 'r/SharedB.swift'), 'struct ChangedRecord {}\n');
    await verifyBundle(ready.directory);
    await assert.rejects(verifyCurrentBundle(ready.directory, f.runtime, signal()), /sourceChanged/);
    await writeFile(join(f.directory, 'publication-proof.json'), JSON.stringify({ manifest: ready.manifest,
      rejected: ['missing', 'manual', 'unrelated', 'explicit-codemap', 'changed-source'] }, null, 2));
  } finally { await f.runtime.close(); }
});

test('duplicate saved inventory entries cannot suppress inferred membership in a consistently rehashed bundle', async () => {
  const f = await fixture();
  try {
    const draft = await f.workspace.createDraft({ ...request, requiredSources: [fullSeed] }, signal());
    await draft.update({ expectedRevision: 0, maxOutputBytes, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) } }, signal());
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    const saved = await loadVerifiedBundle(ready.directory), manifest = structuredClone(ready.manifest);
    const dependency = manifest.inventory.entries.find(entry => entry.root === 'r' && entry.path === 'Peer.swift');
    assert(dependency?.kind === 'file');
    const suppressedPostingSize = 4097;
    for (let count = 1; count < suppressedPostingSize; count++) manifest.inventory.entries.push(structuredClone(dependency));
    manifest.inventory.inventoryDigest = inventoryDigest(manifest.inventory);
    const materials = saved.materials.filter(item => item.record.id !== sourceId(dependency));
    const rendered = renderBundle(await prepareClipboard(f.runtime, { request: manifest.request, inventory: manifest.inventory, prompt: manifest.prompt,
      automaticAcquisition: { kind: 'settled', outcomes: manifest.automaticCodemaps },
      codemapMode: manifest.codemapMode, materials,
      fileTree: { input: finalFileTreeInput(manifest.inventory, materials, manifest.codemapMode), text: saved.fileTree.text } }, signal()));
    manifest.fileTree = { input: finalFileTreeInput(manifest.inventory, materials, manifest.codemapMode), span: rendered.fileTreeSpan };
    assert.deepEqual(rendered.diagnostics, []);
    manifest.materials = rendered.records; manifest.files = { context: identity(rendered.context), handoff: identity(rendered.handoff) };
    manifest.accounting.bytes = rendered.measurement.bytes; manifest.accounting.units = rendered.measurement.units;
    await writeFile(join(ready.directory, 'context.md'), rendered.context); await writeFile(join(ready.directory, 'handoff.md'), rendered.handoff);
    await writeFile(join(ready.directory, 'manifest.json'), canonicalJSON(manifest));
    await assert.rejects(verifyBundle(ready.directory), /bundleIntegrityFailed/);
    await writeFile(join(f.directory, 'duplicate-inventory-proof.json'), JSON.stringify({ suppressedPostingSize,
      removed: sourceId(dependency), inventoryDigest: manifest.inventory.inventoryDigest, rejected: 'bundleIntegrityFailed' }, null, 2));
  } finally { await f.runtime.close(); }
});

test('automatic codemaps retain a dependency accepted by the source decoder even when its text contains NUL', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'r/SharedB.swift'), f.files['SharedB.swift'] + '\0');
    await f.workspace.refresh(signal());
    const draft = await f.workspace.createDraft({ ...request, requiredSources: [fullSeed] }, signal());
    try {
      assert((await sources(draft)).some(item => item.kind === 'source' && item.selection.source.path === 'SharedB.swift'));
      const result = await draft.finalize(signal()); assert(result.kind === 'ready');
      await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, f.runtime, signal());
      await writeFile(join(f.directory, 'decoded-dependency-proof.json'), JSON.stringify(result.manifest.files, null, 2));
    } finally { await draft.close(); }
  } finally { await f.runtime.close(); }
});

test('optional inferred acquisition failure retains ready targets and records verifiable partial membership', async t => {
  for (const admission of [false, true]) for (const cause of ['sourceChanged', 'notFound'] as const) await t.test((admission ? 'required admission/' : 'upsert/') + cause, async () => {
    let armed = false;
    const f = await fixture(async (path, pinned) => {
      if (armed && pinned && path === 'SharedB.swift') {
        armed = false;
        const path = join(f.directory, 'r/SharedB.swift');
        if (cause === 'sourceChanged') await writeFile(path, 'struct ChangedRecord {}\n');
        else await rename(path, path + '.saved');
      }
    });
    try {
      const pinned = await f.workspace.openOperation(signal()); await pinned.close();
      const draft = admission ? null : await f.workspace.createDraft(request, signal());
      armed = true;
      const selected = draft ?? await f.workspace.createDraft({ ...request, requiredSources: [fullSeed] }, signal());
      if (draft) await draft.update({ expectedRevision: 0, maxOutputBytes, mutation: { kind: 'upsert', selection: fullSeed } }, signal());
      assert.equal(selected.revision, admission ? 0 : 1);
      assert.deepEqual((await sources(selected)).map(item => item.selection.source.path).sort(), ['Peer.swift', 'Seed.swift', 'SharedA.swift']);
      // Historical acquisition evidence is distinct from selection-get stale-publication exhaustion.
      const reply = cause === 'notFound' ? await selected.manageSelection(selectionValidator.Parse(selectionValidator.Default({
        op: 'get', view: 'files', maxOutputBytes,
      })), signal()) : null;
      if (reply) assert.deepEqual(reply.code_structure?.unmapped_paths, ['r/SharedB.swift']);
      const ready = await selected.finalize(signal()); assert(ready.kind === 'ready');
      await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
      const captured = Compile(Type.Object({ automaticCodemaps: Type.Array(Type.Object({
        source: Type.Object({ root: Type.String(), path: Type.String() }), identity: Type.Object({ sha256: Type.String(), byteCount: Type.Integer() }),
        artifactKey: Type.Object({ digest: Type.String(), canonicalBase64: Type.String() }),
        outcome: Type.Union([Type.Object({ kind: Type.Literal('ready') }), Type.Object({ kind: Type.Literal('unavailable'), cause: Type.String() })]),
      })) })).Parse(ready.manifest);
      assert.equal(captured.automaticCodemaps.length, 3);
      assert.deepEqual(captured.automaticCodemaps.filter(item => item.outcome.kind === 'unavailable').map(item => ({ source: item.source, outcome: item.outcome })),
        [{ source: { root: 'r', path: 'SharedB.swift' }, outcome: { kind: 'unavailable', cause } }]);
      for (const scenario of ['missing', 'duplicate', 'wrong-identity', 'claimed-ready'] as const) {
        const table = structuredClone(captured.automaticCodemaps), failed = table.find(item => item.outcome.kind === 'unavailable'); assert(failed);
        if (scenario === 'missing') table.splice(table.indexOf(failed), 1);
        else if (scenario === 'duplicate') table.push(failed);
        else if (scenario === 'wrong-identity') failed.identity.sha256 = '0'.repeat(64);
        else failed.outcome = { kind: 'ready' };
        await writeFile(join(ready.directory, 'manifest.json'), canonicalJSON({ ...ready.manifest, automaticCodemaps: table }));
        await assert.rejects(verifyBundle(ready.directory), /bundleIntegrityFailed/);
      }
      await writeFile(join(ready.directory, 'manifest.json'), canonicalJSON(ready.manifest));
      await mkdir('test-output', { recursive: true });
      await writeFile('test-output/automatic-partial-' + (admission ? 'admission' : 'upsert') + '-' + cause + '-proof.json', JSON.stringify({ ready, captured, reply }, null, 2) + '\n');
    } finally { await f.runtime.close(); }
  });
});

test('automatic selection get retries unavailable targets without overwriting a newer selection', async t => {
  for (const scenario of ['recover', 'concurrent-manual'] as const) await t.test(scenario, async () => {
    let action: 'change' | 'hold' | 'none' = 'change';
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(async (path, pinned) => {
      if (!pinned || path !== 'SharedB.swift') return;
      if (action === 'change') {
        action = 'none'; await writeFile(join(f.directory, 'r/SharedB.swift'), 'struct ChangedRecord {}\n');
      } else if (action === 'hold') { action = 'none'; entered(); await held; }
    });
    try {
      const draft = await f.workspace.createDraft({ ...request, requiredSources: [fullSeed] }, signal());
      assert.equal((await sources(draft)).length, 3);
      await writeFile(join(f.directory, 'r/SharedB.swift'), f.files['SharedB.swift']);
      action = scenario === 'concurrent-manual' ? 'hold' : 'none';
      const work = draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'files', maxOutputBytes })), signal());
      const replies: Awaited<typeof work>[] = [];
      if (scenario === 'concurrent-manual') {
        const rejected = assert.rejects(work, /revisionConflict/);
        await Promise.race([entering, rejected]);
        await draft.update({ expectedRevision: 0, maxOutputBytes, mutation: { kind: 'clearCodemaps' } }, signal());
        release(); await rejected;
        assert.equal(draft.revision, 1); assert.equal((await sources(draft)).length, 1);
      } else {
        const reply = await work;
        replies.push(reply);
        assert.equal(reply.revision, 0); assert.equal(draft.revision, 0);
        assert.equal((await sources(draft)).length, 4);
        assert(reply.files.some(file => file.path.endsWith('SharedB.swift')));
        await writeFile(join(f.directory, 'r/SharedB.swift'), 'struct ChangedAgain { let title: String }\n');
        const unavailable = await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'files', maxOutputBytes })), signal());
        replies.push(unavailable);
        assert.equal(unavailable.revision, 0); assert.equal((await sources(draft)).length, 1);
        assert.equal(unavailable.measurement.complete, false);
        assert(!unavailable.files.some(file => file.render_mode === 'codemap'));
        const blocked = await draft.finalize(signal()); assert.equal(blocked.kind, 'blocked');
        await writeFile(join(f.directory, 'r/SharedB.swift'), f.files['SharedB.swift']);
        const recovered = await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'files', maxOutputBytes })), signal());
        replies.push(recovered);
        assert.equal(recovered.revision, 0); assert.equal(recovered.measurement.complete, true);
        assert.equal((await sources(draft)).length, 4);
      }
      const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
      await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
      await mkdir('test-output', { recursive: true });
      await writeFile('test-output/automatic-get-' + scenario + '-proof.json', JSON.stringify({ scenario, ready, replies }, null, 2) + '\n');
    } finally { release(); await f.runtime.close(); }
  });
});

test('manage selection persists explicit intent before automatic acquisition and fences later presentation', async t => {
  for (const scenario of ['complete', 'cancel', 'reply-cap', 'concurrent-manual', 'freeze'] as const) await t.test(scenario, async () => {
    let armed = false, entered!: () => void, release!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(async (path, pinned) => {
      if (armed && pinned && path === 'SharedA.swift') { armed = false; entered(); await held; }
    });
    const abort = new AbortController();
    const draft = await f.workspace.createDraft(request, signal()); armed = true;
    const work = draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'set', paths: ['r/Seed.swift'],
      view: 'files', maxOutputBytes: scenario === 'reply-cap' ? 1 : maxOutputBytes })), abort.signal);
    const observed = (async () => {
      try { return { kind: 'reply' as const, reply: await work }; }
      catch (error) { return { kind: 'error' as const, code: failureCode(error) }; }
    })();
    try {
      await Promise.race([entering, observed.then(() => { throw new Error('Automatic acquisition was not held'); })]);
      assert.equal(draft.revision, 1);
      assert.deepEqual((await sources(draft)).map(item => item.selection.source.path), ['Seed.swift']);
      const pending = await draft.inspect({ view: 'metadata', maxOutputBytes, continuation: null }, signal());
      assert(pending.kind === 'metadata'); assert.equal(pending.measurement.complete, false);
      assert(pending.diagnostics.some(item => item.code === 'automaticCodemapsPending'));
      const observations: unknown[] = [pending];
      if (scenario === 'cancel') abort.abort();
      else if (scenario === 'concurrent-manual') await draft.update({ expectedRevision: 1, maxOutputBytes, mutation: { kind: 'clearCodemaps' } }, signal());
      else if (scenario === 'freeze') {
        const blocked = await draft.finalize(signal()); assert.equal(blocked.kind, 'blocked');
        if (blocked.kind === 'blocked') assert.equal(blocked.measurement.complete, false);
        observations.push(blocked);
      }
      release();
      const outcome = await observed;
      if (scenario === 'cancel' || scenario === 'reply-cap') {
        assert(outcome.kind === 'error');
        assert.equal(outcome.code, scenario === 'cancel' ? 'cancelled' : 'outputBudgetTooSmall');
        observations.push(outcome);
      } else { assert(outcome.kind === 'reply'); assert.equal(outcome.reply.revision, 1); observations.push(outcome.reply); }
      if (scenario === 'cancel' || scenario === 'freeze') {
        const unresolved = await draft.inspect({ view: 'metadata', maxOutputBytes, continuation: null }, signal());
        assert(unresolved.kind === 'metadata'); assert.equal(unresolved.measurement.complete, false);
        observations.push(unresolved);
      }
      if (scenario === 'concurrent-manual') {
        assert.equal(draft.revision, 2); assert.equal((await sources(draft)).length, 1);
      } else {
        assert.equal(draft.revision, 1);
        await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'files', maxOutputBytes })), signal());
        assert.equal((await sources(draft)).length, 4); assert.equal(draft.revision, 1);
      }
      const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
      await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
      await mkdir('test-output', { recursive: true });
      await writeFile('test-output/automatic-ordering-' + scenario + '-proof.json', JSON.stringify({ scenario, observations, ready }, null, 2) + '\n');
    } finally { release(); await observed; await f.runtime.close(); }
  });
});

test('held inferred acquisition cannot commit across cancellation, close, competing revision or freeze', async t => {
  for (const scenario of ['cancel', 'close', 'revision', 'freeze'] as const) await t.test(scenario, async () => {
    let entered!: () => void, release!: () => void, armed = false;
    const entering = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(async path => { if (armed && path === 'SharedA.swift') { armed = false; entered(); await held; } });
    try {
      const draft = await f.workspace.createDraft({ ...request, budgetUnits: scenario === 'freeze' ? 1 : request.budgetUnits }, signal()), abort = new AbortController(); armed = true;
      const pending = draft.update({ expectedRevision: 0, maxOutputBytes, mutation: { kind: 'upsert', selection: fullSeed } }, abort.signal);
      const rejected = assert.rejects(pending, scenario === 'revision' ? /revisionConflict/ : scenario === 'freeze' ? /draftFrozen/ : /cancelled|aborted/i);
      await Promise.race([entering, pending.then(() => { throw new Error('Inferred read was not reached'); })]);
      let closing: Promise<void> | null = null;
      if (scenario === 'cancel') abort.abort();
      else if (scenario === 'close') closing = draft.close();
      else if (scenario === 'revision') await draft.update({ expectedRevision: 0, maxOutputBytes, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) } }, signal());
      else assert.equal((await draft.finalize(signal())).kind, 'blocked');
      release(); await rejected; await closing;
      assert.deepEqual((await sources(draft)), []);
    } finally { release(); await f.runtime.close(); }
  });
});

test('cancelling a job during inferred admission joins native work before reporting local settlement', async () => {
  let entered!: () => void, release!: () => void, armed = false, calls = 0;
  const entering = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async (path, pinned) => { if (armed && pinned && path === 'SharedA.swift') { armed = false; entered(); await held; } });
  try {
    const client = f.runtime.createClient({ run: async () => { calls++; throw new Error('Unexpected scout dispatch'); } });
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: join(f.directory, 'r') }],
      exclusions: [], outputRoot: join(f.directory, 'out') }, signal());
    armed = true;
    const job = client.build(workspace.id, 'cancel-admission', { ...request, requiredSources: [fullSeed] });
    const settling = client.wait(job.jobId, 10000, signal(), () => {});
    await Promise.race([entering, settling.then(() => { throw new Error('Inferred admission was not reached'); })]);
    client.cancel(job.jobId); release();
    const result = await settling;
    assert.equal(result.state, 'cancelled'); assert.equal(result.localSettled, true); assert.equal(calls, 0);
    await writeFile(join(f.directory, 'admission-cancellation-proof.json'), JSON.stringify({ result, calls }, null, 2));
  } finally { release(); await f.runtime.close(); }
});

test('complete inferred cost changes respect encoded receipt admission and packet overage is never silently pruned', async () => {
  const f = await fixture();
  try {
    const probe = await f.workspace.createDraft(request, signal()), draft = await f.workspace.createDraft(request, signal());
    const mutation = { kind: 'upsert' as const, selection: fullSeed };
    const full = await probe.update({ expectedRevision: 0, maxOutputBytes, mutation }, signal());
    const minimum = { ...full, changedCosts: [], incompleteDetails: true, costInspection: { draftId: draft.id, revision: 1 } };
    const cap = Buffer.byteLength(JSON.stringify(minimum));
    await assert.rejects(draft.update({ expectedRevision: 0, maxOutputBytes: cap - 1, mutation }, signal()), /outputBudgetTooSmall/);
    assert.equal(draft.revision, 0); assert.deepEqual((await sources(draft)), []);
    const changed = await draft.update({ expectedRevision: 0, maxOutputBytes: cap, mutation }, signal());
    assert.equal(changed.incompleteDetails, true); assert.equal((await sources(draft)).length, 4);
    const costs = (await draft.inspect({ view: 'costs', maxOutputBytes, continuation: null }, new AbortController().signal));
    assert(costs.kind === 'costs'); assert.equal(costs.items.length, 4);
    const small = await f.workspace.createDraft({ ...request, budgetUnits: 1 }, signal());
    const over = await small.update({ expectedRevision: 0, maxOutputBytes, mutation }, signal());
    assert.equal((await sources(small)).length, 4); assert(over.diagnostics.some(item => item.code === 'overBudget'));
    assert.equal((await small.finalize(signal())).kind, 'blocked');
  } finally { await f.runtime.close(); }
});

test('a real scripted scout resolves supplied-patch inferred mismatches before the job closes', async () => {
  const provider = await scriptedProvider((summary, index) => {
    assert.equal(summary, false);
    if (index === 1 || index === 4) return { kind: 'tool', name: 'draft_validate', input: { maxOutputBytes }, stop: 'tool_use', tokens: 10 };
    if (index === 2) return { kind: 'tool', name: 'draft_update', input: { expectedRevision: 0, maxOutputBytes,
      mutation: { kind: 'clearCodemaps' } }, stop: 'tool_use', tokens: 10 };
    if (index === 3) return { kind: 'tool', name: 'draft_update', input: { expectedRevision: 1, maxOutputBytes,
      mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) } }, stop: 'tool_use', tokens: 10 };
    return { kind: 'text', text: 'Context committed.', stop: 'end_turn', tokens: 10 };
  });
  const f = await fixture();
  try {
    const client = f.runtime.createClient(new PiRunner(provider.config, f.runtime.supervisor));
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: join(f.directory, 'r') }],
      exclusions: [], outputRoot: join(f.directory, 'out') }, signal());
    const job = client.build(workspace.id, 'supplied-review', { ...request, enhancementMode: 'augment' as const, purpose: 'review', requiredSources: [fullSeed],
      patches: [{ kind: 'suppliedPatch', id: 'change', root: 'r', text: 'Complete supplied comparison evidence\n', origin: 'fixture',
        comparison: { kind: 'supplied', base: 'before', target: 'after' }, coverage: ['Seed.swift'],
        targets: [{ path: 'Seed.swift', identity: identity(f.files['Seed.swift']), mode: '100644' }] }] });
    const result = await client.wait(job.jobId, 10000, signal(), () => {});
    assert.equal(result.state, 'ready', JSON.stringify(result)); assert(result.state === 'ready');
    assert(provider.requests.some(item => JSON.stringify(item.messages).includes('sourceComparisonMismatch')));
    const verified = await verifyBundle(result.bundle.directory);
    assert.equal(verified.manifest.codemapMode, 'manual');
    assert.equal(verified.manifest.materials.filter(item => item.kind === 'source').length, 1);
    await writeFile(join(f.directory, 'supplied-patch-recovery-proof.json'), JSON.stringify({ result, requests: provider.requests }, null, 2));
  } finally { await f.runtime.close(); await provider.close(); }
});
