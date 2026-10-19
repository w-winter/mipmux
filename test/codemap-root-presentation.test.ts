import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime, verifyBundle } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { selectionValidator } from '../src/contracts/selection.js';

const sourceCase = Type.Object({ name: Type.String(), roots: Type.Array(Type.Object({ root: Type.String(), files: Type.Array(Type.Object({
  name: Type.String(), outcome: Type.Enum(['ready', 'readyNoSymbols']), currentness: Type.Enum(['current', 'stale', 'staleOnRevalidation']),
  handle: Type.Enum(['valid', 'revoked']),
})) })) });
const referenceInputs = Compile(Type.Array(sourceCase));
const referenceOutputs = Compile(Type.Array(Type.Object({ name: Type.String(), pending: Type.Array(Type.String()), unmapped: Type.Array(Type.String()),
  roots: Type.Array(Type.Object({ root: Type.String(), status: Type.Enum(['ready', 'unavailable']), rendered: Type.Array(Type.String()) })),
})));
const referenceDirectory = 'test/fixtures/rpce-root-presentation/';
const body = 'struct Item { let value: Int }\n';

async function fixture(input: Static<typeof sourceCase>, beforeRead: (path: string) => Promise<void>) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'smip-root-presentation-')));
  const roots = [];
  const selections = [];
  for (const root of input.roots) {
    const absolutePath = join(base, root.root);
    await mkdir(absolutePath);
    roots.push({ name: root.root, absolutePath });
    for (const file of root.files) {
      await writeFile(join(absolutePath, file.name), file.outcome === 'ready' ? body : '');
      selections.push({ kind: 'codemap' as const, source: { root: root.root, path: file.name } });
    }
  }
  const requiredFile = input.roots.find(root => root.root === 'a')!.files.find(file => file.outcome === 'ready')!;
  const required = { kind: 'codemap' as const, source: { root: 'a', path: requiredFile.name } };
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (operation.kind === 'readSource') await beforeRead(operation.path);
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const output = join(base, 'out'); await mkdir(output);
  const runtime = new Runtime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = new AbortController().signal, client = runtime.createClient(null);
  const workspace = await client.declare({ roots, exclusions: [], outputRoot: output }, signal);
  const draft = await client.createDraft(workspace.id, { task: 'Inspect', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
    initialSelection: { codemapMode: 'manual', sources: selections.reverse().filter(item => item.source.root !== required.source.root || item.source.path !== required.source.path) },
    requiredSources: [required], documents: [], patches: [], storedPrompts: [], duplicateUserInstructionsAtTop: false,
    copyPreset: 'standard', budgetUnits: 100000, discoveryHints: [], outputName: input.name }, signal);
  const get = (requestSignal = signal) => client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
    op: 'get', view: 'content', maxOutputBytes: 30000,
  })), requestSignal);
  return { base, runtime, client, draft, signal, get, required };
}

test('root codemap replies match original all-or-none rendering and recover required membership', async () => {
  const inputs = referenceInputs.Parse(JSON.parse(await readFile(referenceDirectory + 'inputs.json', 'utf8')));
  const outputs = referenceOutputs.Parse(JSON.parse(await readFile(referenceDirectory + 'expected.json', 'utf8')));
  const receipts = [];
  for (const input of inputs.filter(entry => entry.roots.every(root => root.files.every(file => file.currentness === 'current' && file.handle === 'valid')))) {
    const expected = outputs.find(output => output.name === input.name)!;
    const f = await fixture(input, async () => {});
    try {
      const reply = await f.get();
      assert.equal(reply.revision, 0);
      assert.deepEqual(reply.files.map(file => file.path).sort(), expected.roots.flatMap(root => root.rendered).sort(), input.name);
      assert.deepEqual([...(reply.code_structure?.pending_paths ?? [])].sort(), [...expected.pending].sort(), input.name);
      assert.deepEqual([...(reply.code_structure?.unmapped_paths ?? [])].sort(), [...expected.unmapped].sort(), input.name);
      assert.equal(reply.measurement.complete, expected.pending.length === 0);
      if (expected.pending.length) {
        const blocked = await f.client.finalize(f.draft.id, f.signal); assert.equal(blocked.kind, 'blocked');
        await assert.rejects(f.client.manageSelection(f.draft.id, selectionValidator.Parse(selectionValidator.Default({
          op: 'remove', mode: 'codemap_only', paths: ['a/' + f.required.source.path], maxOutputBytes: 30000,
        })), f.signal), /requiredMaterialMutation/);
        const recovered = await f.client.manageSelection(f.draft.id, selectionValidator.Parse(selectionValidator.Default({
          op: 'remove', mode: 'codemap_only', paths: input.roots.flatMap(root => root.files
            .filter(file => file.outcome === 'readyNoSymbols').map(file => root.root + '/' + file.name)), view: 'content', maxOutputBytes: 30000,
        })), f.signal);
        assert.equal(recovered.revision, 1); assert.equal(recovered.measurement.complete, true);
        assert(recovered.files.some(file => file.path === 'a/' + f.required.source.path));
        receipts.push({ name: input.name, reply, blocked, recovered });
      } else receipts.push({ name: input.name, reply });
      const finalized = await f.client.finalize(f.draft.id, f.signal); assert.equal(finalized.kind, 'ready');
      if (finalized.kind === 'ready') await verifyBundle(finalized.directory);
    } finally { await f.client.close(); await f.runtime.close(); }
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/root-codemap-atomic-proof.json', JSON.stringify(receipts, null, 2) + '\n');
});

test('root rendering revalidates the whole batch and joins cancellation or unexpected read failures', async () => {
  const inputs = referenceInputs.Parse(JSON.parse(await readFile(referenceDirectory + 'inputs.json', 'utf8')));
  const outputs = referenceOutputs.Parse(JSON.parse(await readFile(referenceDirectory + 'expected.json', 'utf8')));
  const allReady = inputs.find(input => input.name === 'all-ready')!;
  const receipts = [];
  for (const scenario of ['stale-middle', 'stale-on-revalidation', 'mode-on-revalidation', 'cancel', 'failure'] as const) {
    let armed = false, entered!: () => void, release!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ ...allReady, name: scenario }, async path => {
      if (!armed || path !== (scenario === 'stale-on-revalidation' || scenario === 'mode-on-revalidation' ? '3.swift' : '2.swift')) return;
      armed = false;
      if (scenario === 'failure') throw new Error('Fixture root body read failed');
      if (scenario === 'cancel') { entered(); await held; return; }
      const changed = join(f.base, 'a', scenario === 'stale-middle' ? '2.swift' : '1.swift');
      if (scenario === 'mode-on-revalidation') await chmod(changed, 0o755);
      else await writeFile(changed, 'struct Changed { let flag: Bool }\n');
    });
    try {
      await f.get(); armed = true;
      if (scenario === 'cancel') {
        const abort = new AbortController();
        const work = f.get(abort.signal);
        await Promise.race([entering, work.then(() => { throw new Error('Reply settled before the held root read'); })]);
        const rejected = assert.rejects(work, /cancelled|aborted|nativeWorkerClosed/i);
        abort.abort(); release(); await rejected;
      } else if (scenario === 'failure') await assert.rejects(f.get(), /Fixture root body read failed/);
      else {
        const expected = outputs.find(output => output.name === (scenario === 'mode-on-revalidation' ? 'stale-on-revalidation' : scenario))!;
        const reply = await f.get();
        assert.equal(reply.revision, 0); assert.equal(reply.measurement.complete, false);
        // The reference covers one root-render attempt; outer stale-publication retries are a separate contract.
        assert(reply.files.every(file => !file.path.startsWith('a/')));
        assert(expected.pending.every(path => reply.code_structure?.pending_paths?.includes(path)), scenario);
        assert.deepEqual(reply.code_structure?.unmapped_paths ?? [], []);
        receipts.push({ scenario, reply });
        await writeFile(join(f.base, 'a', scenario === 'stale-middle' ? '2.swift' : '1.swift'), body);
        if (scenario === 'mode-on-revalidation') await chmod(join(f.base, 'a', '1.swift'), 0o644);
      }
      const recovered = await f.get();
      assert.equal(recovered.revision, 0); assert.equal(recovered.measurement.complete, true); assert.equal(recovered.files.length, 4);
      const finalized = await f.client.finalize(f.draft.id, f.signal); assert.equal(finalized.kind, 'ready');
      if (finalized.kind === 'ready') await verifyBundle(finalized.directory);
      receipts.push({ scenario, recovered, finalized });
    } finally { release(); await f.client.close(); await f.runtime.close(); }
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/root-codemap-currentness-proof.json', JSON.stringify(receipts, null, 2) + '\n');
});

test('stale serving authority takes precedence over a nonrenderable codemap', async () => {
  const inputs = referenceInputs.Parse(JSON.parse(await readFile(referenceDirectory + 'inputs.json', 'utf8')));
  const outputs = referenceOutputs.Parse(JSON.parse(await readFile(referenceDirectory + 'expected.json', 'utf8')));
  const input = inputs.find(input => input.name === 'nonrenderable-stale')!;
  const expected = outputs.find(output => output.name === input.name)!;
  let armed = false;
  const f = await fixture(input, async path => {
    if (armed && path === '2.swift') { armed = false; await chmod(join(f.base, 'a', path), 0o755); }
  });
  try {
    armed = true;
    const reply = await f.get();
    assert.equal(reply.measurement.complete, false);
    assert(reply.files.every(file => !file.path.startsWith('a/')));
    assert(expected.pending.every(path => reply.code_structure?.pending_paths?.includes(path)));
    assert.deepEqual(reply.code_structure?.unmapped_paths ?? [], expected.unmapped);
    await chmod(join(f.base, 'a', '2.swift'), 0o644);
    const recovered = await f.client.manageSelection(f.draft.id, selectionValidator.Parse(selectionValidator.Default({
      op: 'remove', mode: 'codemap_only', paths: ['a/2.swift'], view: 'content', maxOutputBytes: 30000,
    })), f.signal);
    assert.equal(recovered.revision, 1); assert.equal(recovered.measurement.complete, true); assert.equal(recovered.files.length, 3);
    const finalized = await f.client.finalize(f.draft.id, f.signal); assert.equal(finalized.kind, 'ready');
    if (finalized.kind === 'ready') await verifyBundle(finalized.directory);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/root-codemap-stale-terminal-proof.json', JSON.stringify({ reply, recovered, finalized }, null, 2) + '\n');
  } finally { await f.client.close(); await f.runtime.close(); }
});
