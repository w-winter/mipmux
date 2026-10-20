import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { selectionValidator } from '../src/contracts/selection.js';

const signal = () => new AbortController().signal;
type Effect = 'missing' | 'directory' | 'symlink' | 'readDenied' | 'lateMissing' | 'required' | 'cancel';
const omissions = Compile(Type.Object({ unavailableFiles: Type.Array(Type.Object({ code: Type.String(), disposition: Type.String(),
  selection: Type.Object({ kind: Type.String(), source: Type.Object({ root: Type.String(), path: Type.String() }) }) })) }));

async function fixture(effect: Effect) {
  const base = await mkdtemp(join(tmpdir(), 'smip-manual-io-'));
  for (const path of ['a', 'b', 'out']) await mkdir(join(base, path));
  await writeFile(join(base, 'a/Target.swift'), 'struct UnavailableMap { let value: Int }\n');
  await writeFile(join(base, 'a/Healthy.swift'), 'struct SameRootMap { let value: String }\n');
  await writeFile(join(base, 'a/full.txt'), 'READABLE FULL BODY\n');
  await writeFile(join(base, 'b/Other.swift'), 'struct IndependentMap { let value: Bool }\n');
  await writeFile(join(base, 'external.swift'), 'EXTERNAL TARGET MUST NOT BE READ\n');
  let armed = false, lateRemoved = false, entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (armed && operation.kind === 'readSource') {
            if (effect === 'cancel' && operation.path === 'Healthy.swift') { armed = false; entered(); await held; }
            if (effect === 'readDenied' && operation.path === 'Target.swift') throw new NativeFailure('permissionDenied', null);
            if (effect === 'lateMissing' && operation.path === 'Target.swift' && operation.expected !== null) {
              armed = false; lateRemoved = true; await rename(join(base, 'a/Target.swift'), join(base, 'original.swift'));
            }
          }
          return super.request(operation, requestSignal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const workspace = await runtime.declare({ roots: ['a', 'b'].map(name => ({ name, absolutePath: join(base, name) })),
    exclusions: [], outputRoot: join(base, 'out') }, signal());
  const target = { kind: 'codemap' as const, source: { root: 'a', path: 'Target.swift' } };
  const draft = await workspace.createDraft({ task: 'Keep readable code structure', constraints: '', purpose: 'investigation', enhancementMode: 'preserve',
    initialSelection: { codemapMode: 'manual', sources: [target, { kind: 'codemap', source: { root: 'a', path: 'Healthy.swift' } },
      { kind: 'codemap', source: { root: 'b', path: 'Other.swift' } }, { kind: 'full', source: { root: 'a', path: 'full.txt' } }] },
    requiredSources: effect === 'required' ? [target] : [], documents: [], patches: [], copyPreset: 'standard',
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 100000, outputName: 'packet' }, signal());
  if (effect === 'missing' || effect === 'directory' || effect === 'symlink' || effect === 'required') {
    await rename(join(base, 'a/Target.swift'), join(base, 'original.swift'));
    if (effect === 'directory') await mkdir(join(base, 'a/Target.swift'));
    if (effect === 'symlink') await symlink(join(base, 'external.swift'), join(base, 'a/Target.swift'));
  }
  armed = true;
  const get = (requestSignal = signal()) => draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({
    op: 'get', view: 'content', maxOutputBytes: 100000 })), requestSignal);
  return { base, runtime, workspace, draft, get, entering, release, stopFault: () => { armed = false; }, lateRemoved: () => lateRemoved };
}

for (const [effect, refresh] of [['missing', false], ['missing', true], ['directory', false], ['symlink', false], ['readDenied', false], ['lateMissing', false]] as const) {
  test(`manual codemap ${effect} projects source diagnostics and exports healthy evidence after refresh ${refresh}`, async () => {
    const f = await fixture(effect);
    try {
      if (refresh) await f.workspace.refresh(signal());
      const selected = f.draft.selectionProjection(), reply = await f.get();
      assert(reply.blocks?.some(block => block.includes('SameRootMap'))); assert(reply.blocks?.some(block => block.includes('IndependentMap')));
      assert(reply.blocks?.some(block => block.includes('READABLE FULL BODY')));
      assert(!reply.blocks?.some(block => block.includes('UnavailableMap') || block.includes('EXTERNAL TARGET')));
      if (!refresh) {
        const paths = effect === 'readDenied' ? reply.code_structure?.pending_paths : reply.code_structure?.unmapped_paths;
        assert(paths?.includes('a/Target.swift'), JSON.stringify(reply));
      }
      assert.deepEqual(f.draft.selectionProjection(), selected); assert.equal(reply.revision, 0);
      if (effect === 'lateMissing') assert(f.lateRemoved());
      const ready = await f.draft.finalize(signal()); assert(ready.kind === 'ready', JSON.stringify(ready));
      const omitted = omissions.Parse(ready.manifest).unavailableFiles;
      assert.deepEqual(omitted.map(file => [file.selection.source.path, file.selection.kind, file.code, file.disposition]),
        [['Target.swift', 'codemap', effect === 'readDenied' ? 'permissionDenied' : effect === 'symlink' ? 'symlink' : effect === 'directory' ? 'nonRegularFile' : 'notFound',
          effect === 'readDenied' ? 'pending' : 'unmapped']]);
      await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
      if (effect === 'missing' || effect === 'readDenied' || effect === 'lateMissing') {
        f.stopFault();
        if (effect !== 'readDenied') await rename(join(f.base, 'original.swift'), join(f.base, 'a/Target.swift'));
        await assert.rejects(verifyCurrentBundle(ready.directory, f.runtime, signal()), /sourceAvailabilityChanged/);
        await verifyBundle(ready.directory);
      }
      await mkdir('test-output', { recursive: true });
      await writeFile(`test-output/manual-codemap-io-${effect}-${refresh}.json`, JSON.stringify({ reply, ready, selected }, null, 2) + '\n');
    } finally { f.release(); await f.runtime.close(); }
  });
}

test('unavailable required manual codemap remains selected and prevents publication', async () => {
  const f = await fixture('required');
  try {
    const selected = f.draft.selectionProjection(), reply = await f.get();
    assert(reply.code_structure?.unmapped_paths?.includes('a/Target.swift'));
    assert.deepEqual(f.draft.selectionProjection(), selected);
    await assert.rejects(f.draft.finalize(signal()), /notFound/);
    await assert.rejects(readFile(join(f.base, 'out/packet/manifest.json')), /ENOENT/);
  } finally { f.release(); await f.runtime.close(); }
});

test('manual codemap I/O cancellation joins work without publishing', async () => {
  const f = await fixture('cancel'), controller = new AbortController();
  try {
    const work = f.get(controller.signal);
    await Promise.race([f.entering, work.then(() => { throw new Error('Read escaped its cancellation gate'); })]);
    const rejected = assert.rejects(work, /cancelled|aborted/i); controller.abort(); f.release(); await rejected;
    await assert.rejects(readFile(join(f.base, 'out/packet/manifest.json')), /ENOENT/);
  } finally { f.release(); await f.runtime.close(); }
});
