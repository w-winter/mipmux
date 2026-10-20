import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { MipmuxRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { loadVerifiedBundle } from '../src/context/verify.js';
import { renderBundle } from '../src/context/render.js';
import { identity } from '../src/context/material-store.js';

const signal = () => new AbortController().signal;
const pendingFiles = Compile(Type.Object({ unavailableFiles: Type.Array(Type.Object({ code: Type.String(),
  selection: Type.Object({ kind: Type.String(), source: Type.Object({ root: Type.String(), path: Type.String() }) }),
  artifactKey: Type.Object({ digest: Type.String() }) })) }));

async function fixture(effect: 'optional' | 'changed' | 'cancel') {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-manual-export-'));
  for (const path of ['a', 'b', 'out']) await mkdir(join(base, path));
  await writeFile(join(base, 'a/full.txt'), 'Readable ordinary content\n');
  await writeFile(join(base, 'a/Empty.swift'), '');
  await writeFile(join(base, 'a/Ready.swift'), 'struct PendingSibling { let value: Int }\n');
  await writeFile(join(base, 'b/Healthy.swift'), 'struct IndependentMap { let value: String }\n');
  let entered!: () => void, release!: () => void, armed = false;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  class Runtime extends MipmuxRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (armed && operation.kind === 'renderPreparedClipboard') { armed = false; entered(); await held; }
          return super.request(operation, requestSignal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const workspace = await runtime.declare({ roots: ['a', 'b'].map(name => ({ name, absolutePath: join(base, name) })),
    exclusions: [], outputRoot: join(base, 'out') }, signal());
  const draft = await workspace.createDraft({ task: 'Export readable context', constraints: '', purpose: 'investigation', enhancementMode: 'preserve',
    initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'a', path: 'full.txt' } },
      { kind: 'codemap', source: { root: 'a', path: 'Ready.swift' } }, { kind: 'codemap', source: { root: 'a', path: 'Empty.swift' } },
      { kind: 'codemap', source: { root: 'b', path: 'Healthy.swift' } }] },
    requiredSources: [], documents: [], patches: [], copyPreset: 'standard', duplicateUserInstructionsAtTop: false,
    budgetUnits: 100000, discoveryHints: [], outputName: 'packet' }, signal());
  if (effect === 'changed') await writeFile(join(base, 'a/Ready.swift'), 'struct ChangedReadableSource {}\n');
  armed = effect === 'cancel';
  return { base, runtime, draft, entering, release };
}

test('manual export omits optional pending root siblings while retaining ordinary content and independent maps', async () => {
  const f = await fixture('optional');
  try {
    const selected = f.draft.selectionProjection(), result = await f.draft.finalize(signal());
    assert(result.kind === 'ready', JSON.stringify(result));
    const omissions = pendingFiles.Parse(result.manifest);
    assert.deepEqual(omissions.unavailableFiles.map(file => [file.selection.source.root, file.selection.source.path, file.selection.kind, file.code]),
      [['a', 'Ready.swift', 'codemap', 'codemapPending']]);
    const context = await readFile(join(result.directory, 'context.md'), 'utf8');
    assert(context.includes('Readable ordinary content')); assert(context.includes('IndependentMap'));
    assert(!context.includes('PendingSibling'));
    await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, f.runtime, signal());
    assert.deepEqual(f.draft.selectionProjection(), selected);
    const costs = await f.draft.inspect({ view: 'costs', maxOutputBytes: 100000, continuation: null }, signal());
    assert(costs.kind === 'costs'); assert.equal(costs.measurement.bytes, result.manifest.accounting.bytes);
    assert(new Set<string>(costs.token_accounting.incomplete_components).has('codemap_presentation'));
    const manifestPath = join(result.directory, 'manifest.json'), handoffPath = join(result.directory, 'handoff.md');
    const savedManifest = await readFile(manifestPath), savedHandoff = await readFile(handoffPath);
    const loaded = await loadVerifiedBundle(result.directory), forged = structuredClone(result.manifest);
    const pending = forged.unavailableFiles.find(file => file.code === 'codemapPending');
    assert(pending?.code === 'codemapPending'); pending.artifactKey.digest = '0'.repeat(64);
    const altered = renderBundle({ manualPresentation: null, request: forged.request, inventory: forged.inventory, prompt: forged.prompt, codemapMode: forged.codemapMode,
      materials: loaded.materials, automaticAcquisition: { kind: 'settled', outcomes: forged.automaticCodemaps }, fileTree: loaded.fileTree,
      unavailableRoots: forged.unavailableRoots, unavailableFiles: forged.unavailableFiles, clipboard: loaded.clipboard,
      clipboardPreset: forged.clipboardPreset, selectedGitDiffIds: [], automaticGit: null });
    forged.files.handoff = identity(altered.handoff);
    try {
      await writeFile(manifestPath, JSON.stringify(forged)); await writeFile(handoffPath, altered.handoff);
      await assert.rejects(verifyBundle(result.directory), /bundleIntegrityFailed/);
    } finally { await writeFile(manifestPath, savedManifest); await writeFile(handoffPath, savedHandoff); }
    await writeFile(join(f.base, 'a/Ready.swift'), 'struct ChangedAfterExport {}\n');
    await assert.rejects(verifyCurrentBundle(result.directory, f.runtime, signal()), /sourceChanged/);
    await verifyBundle(result.directory);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/manual-codemap-export.json', JSON.stringify({ result, selected, costs }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});

test('optional pending codemaps cannot conceal readable source changes', async () => {
  const f = await fixture('changed');
  try {
    await assert.rejects(f.draft.finalize(signal()), /sourceChanged/);
    await assert.rejects(readFile(join(f.base, 'out/packet/manifest.json')), /ENOENT/);
  } finally { await f.runtime.close(); }
});

test('cancellation during optional codemap export prevents publication and joins owned work', async () => {
  const f = await fixture('cancel'), controller = new AbortController();
  try {
    const work = f.draft.finalize(controller.signal);
    await Promise.race([f.entering, work.then(() => { throw new Error('Finalization escaped its gated native boundary'); })]);
    const rejected = assert.rejects(work, /cancelled|aborted/i);
    controller.abort(); f.release(); await rejected;
    await assert.rejects(readFile(join(f.base, 'out/packet/manifest.json')), /ENOENT/);
  } finally { f.release(); await f.runtime.close(); }
});
