import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { contextRequestValidator, type ContextBuildRequest } from '../src/contracts/context.js';
import { selectionValidator } from '../src/contracts/selection.js';
import { gitValidator } from '../src/contracts/git.js';
import { loadVerifiedBundle } from '../src/context/verify.js';
import { renderBundle } from '../src/context/render.js';
import { canonicalJSON } from '../src/workspace/values.js';
import { identity } from '../src/context/material-store.js';

const signal = () => new AbortController().signal;
type Manual = ReturnType<typeof copyContext>;
function manual(usage: Manual['current']['codeMapUsage'] = 'auto', tree: Manual['current']['fileTreeMode'] = 'Auto', git: Manual['current']['gitInclusion'] = 'none'): Manual {
  return { presets: [], current: { fileTreeMode: tree, codeMapUsage: usage, gitInclusion: git },
    customizations: { includeFiles: null, includeUserPrompt: null, includeFileTree: null,
      fileTreeMode: null, codeMapUsage: null, gitInclusion: null },
    codeMapsGloballyDisabled: false, activeGitRoot: 'r' };
}
async function fixture(copyPreset: ReturnType<typeof manual>, mode = 'manual') {
  const request = contextRequestValidator.Parse({ task: 'LITERAL TASK', constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: mode, sources: [
      { kind: 'full', source: { root: 'r', path: 'Full.swift' } },
      { kind: 'slices', source: { root: 'r', path: 'Slice.swift' }, ranges: [{ start: 2, end: 2, description: 'Middle only' }] },
      ...(mode === 'manual' ? [{ kind: 'codemap', source: { root: 'r', path: 'Map.swift' } }] : []),
    ] }, requiredSources: [], documents: [], patches: [], copyPreset: 'manual',
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: 'packet' });
  const base = await mkdtemp(join(tmpdir(), 'smip-manual-preset-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  await writeFile(join(root, 'Full.swift'), 'struct Full { let map: ManualPeer; func body() { print("FULL BODY") } }\n');
  await writeFile(join(root, 'Slice.swift'), 'struct Slice {\nlet value: Int\nfunc body() { print("SLICE TAIL") }\n}\n');
  await writeFile(join(root, 'Map.swift'), 'struct ManualPeer { func body() { print("MAP BODY") } }\n');
  await writeFile(join(root, 'Other.swift'), 'struct Other { func body() { print("OTHER BODY") } }\n');
  const git = '/usr/bin/git', run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8' });
  run(['init', '-q']); run(['add', '.']); run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base']);
  await writeFile(join(root, 'Full.swift'), 'struct Full { let map: ManualPeer; func body() { print("FULL CHANGED") } }\n');
  await writeFile(join(root, 'Other.swift'), 'struct Other { func body() { print("OTHER CHANGED") } }\n');
  const runtime = new SmipRuntime({ copyContext: copyPreset, cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, git: { executable: git } });
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal());
    return { runtime, workspace, root, request, settings: copyPreset, run };
  } catch (error) { await runtime.close(); throw error; }
}

for (const mode of ['manual', 'automatic']) for (const usage of ['none', 'auto', 'selected', 'complete'] as const) {
  test(`Manual ${usage} exports actual ${mode} representations and exact packet costs`, async () => {
    const f = await fixture(manual(usage), mode);
    try {
      const draft = await f.workspace.createDraft(f.request, signal());
      // Only manage_selection slices represent slice-only membership in the source selection model.
      await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'set', mode: 'full',
        paths: ['r/Full.swift'], slices: [{ path: 'r/Slice.swift', ranges: [{ start_line: 2, end_line: 2, description: 'Middle only' }] }],
        maxOutputBytes: 100000 })), signal());
      if (mode === 'manual') await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'add',
        mode: 'codemap_only', paths: ['r/Map.swift'], maxOutputBytes: 100000 })), signal());
      const before = draft.selectionProjection(), revision = draft.revision;
      const costs = await draft.validate(signal());
      const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
      const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
      const maps = ready.manifest.materials.filter(record => record.kind === 'source' && record.selection.kind === 'codemap');
      assert.equal(context.includes('FULL CHANGED'), usage !== 'selected');
      assert(context.includes('let value: Int')); assert(!context.includes('SLICE TAIL'));
      assert.equal(maps.some(record => record.kind === 'source' && record.selection.source.path === 'Full.swift'), usage === 'selected');
      assert.equal(maps.some(record => record.kind === 'source' && record.selection.source.path === 'Other.swift'), usage === 'complete');
      assert.equal(maps.some(record => record.kind === 'source' && record.selection.source.path === 'Map.swift'), usage === 'complete' || usage === 'auto');
      assert.deepEqual(draft.selectionProjection(), before); assert.equal(draft.revision, revision);
      assert.equal(costs.measurement.bytes, Buffer.byteLength(context));
      assert.equal(costs.measurement.units, Math.floor(Buffer.byteLength(context) * 21 / 80));
      assert.equal(ready.manifest.accounting.bytes, Buffer.byteLength(context));
      await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
      await writeFile(`test-output/manual-${mode}-${usage}.json`, JSON.stringify({ directory: ready.directory, costs, manifest: ready.manifest }, null, 2) + '\n');
      await writeFile(join(f.root, usage === 'complete' ? 'Other.swift' : 'Full.swift'), 'changed after export\n');
      await verifyBundle(ready.directory);
      await assert.rejects(verifyCurrentBundle(ready.directory, f.runtime, signal()), /sourceChanged/);
    } finally { await f.runtime.close(); }
  });
}

test('Manual captures current settings and fixed constraints at admission', async () => {
  const f = await fixture(manual('none', 'None'));
  try {
    const captured = { ...f.request, constraints: 'FIXED CALLER CONSTRAINT' };
    const draft = await f.workspace.createDraft(captured, signal());
    captured.constraints = 'LATER CALLER MUTATION';
    Object.assign(f.settings, { current: { fileTreeMode: 'Full', codeMapUsage: 'complete', gitInclusion: 'all' } });
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
    assert(!context.includes('<file_map>')); assert(!context.includes('<git_diff>'));
    assert(context.includes('<constraints>\nFIXED CALLER CONSTRAINT\n</constraints>\n'));
    assert(!context.includes('LATER CALLER MUTATION'));
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
  } finally { await f.runtime.close(); }
});

for (const git of ['selectedFiles', 'all'] as const) test(`Manual ${git} retains its Git scope and required patches`, async () => {
  const f = await fixture(manual('none', 'None', git));
  try {
    const snapshot = await f.workspace.refresh(signal());
    const targets = snapshot.entries.flatMap(entry => entry.kind === 'file' ? [{ path: entry.path, identity: entry.identity, mode: '100644' as const }] : []);
    const draft = await f.workspace.createDraft({ ...f.request, patches: [{ kind: 'suppliedPatch', id: 'required', root: 'r',
      text: 'REQUIRED PATCH\n', origin: 'fixture', comparison: { kind: 'supplied', base: 'before', target: 'after' }, coverage: targets.map(target => target.path), targets }] }, signal());
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
    const diff = context.slice(context.indexOf('<git_diff>'));
    assert(diff.includes('FULL CHANGED')); assert.equal(diff.includes('OTHER CHANGED'), git === 'all');
    assert(diff.includes('REQUIRED PATCH\n'));
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
  } finally { await f.runtime.close(); }
});

test('Manual workspace flags exclude optional bodies and reject later required documents', async () => {
  const preset = manual('none', 'Selected');
  preset.customizations = { ...preset.customizations, includeFiles: false, includeFileTree: false, includeUserPrompt: false };
  const f = await fixture(preset);
  try {
    const draft = await f.workspace.createDraft(f.request, signal());
    await assert.rejects(draft.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'addDocument',
      document: { kind: 'suppliedDocument', id: 'later', role: 'report', origin: 'fixture', text: 'REQUIRED DOCUMENT' } } }, signal()), /copyPresetRequiredMaterialConflict/);
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    assert.equal(await readFile(join(ready.directory, 'context.md'), 'utf8'), '');
    assert.deepEqual(ready.manifest.materials, []);
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
  } finally { await f.runtime.close(); }
});

for (const tree of ['Auto', 'Full', 'Selected', 'None'] as const) test(`Manual ${tree} tree uses captured workspace mode`, async () => {
  const preset = manual('none', 'None'); preset.customizations.fileTreeMode = tree;
  const f = await fixture(preset);
  try {
    const draft = await f.workspace.createDraft(f.request, signal());
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
    assert.equal(context.includes('<file_map>'), tree !== 'None');
    assert.equal(context.includes('Other.swift'), tree === 'Full' || tree === 'Auto');
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
  } finally { await f.runtime.close(); }
});

for (const disabled of [false, true]) test(`Manual current codemap usage ignores workspace override with global disable ${disabled}`, async () => {
  const preset = manual('selected', 'None'); preset.customizations.codeMapUsage = 'none'; preset.codeMapsGloballyDisabled = disabled;
  const f = await fixture(preset);
  try {
    const pending = f.workspace.createDraft(f.request, signal());
    Object.assign(f.settings, { codeMapsGloballyDisabled: !disabled });
    const draft = await pending, ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
    assert.equal(context.includes('FULL CHANGED'), disabled);
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
  } finally { await f.runtime.close(); }
});

test('Manual complete Git selected nonblank patch prevents provider lookup even with a missing local ref', async () => {
  const f = await fixture(manual('none', 'None', 'all'));
  try {
    const draft = await f.workspace.createDraft({ ...f.request, reviewGitBase: 'origin/missing' }, signal());
    const diff = gitValidator.Parse(gitValidator.Default({ op: 'diff', maxOutputBytes: 100000 })); assert(diff.op === 'diff');
    const published = await draft.publishGitSnapshot(diff, { mode: 'standard', scope: 'all', snapshotID: 'selected',
      inlineMap: true, inlineMode: 'brief', inlineMaxLines: 120 }, signal()); assert(published.kind === 'single');
    const patch = published.projection.primarySelectionAliases[1]; assert(patch);
    await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'add', paths: [patch], maxOutputBytes: 100000 })), signal());
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready'); assert.equal(ready.manifest.automaticGit, null);
    const body = await readFile(join(ready.directory, 'context.md'), 'utf8');
    assert(body.includes(await readFile(join(ready.manifest.inventory.outputRoot.declaredPath, patch), 'utf8')));
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
  } finally { await f.runtime.close(); }
});

test('Manual archived verification checks exact presentation and complete Git scope without native execution', async () => {
  const f = await fixture(manual('complete', 'Full', 'all'));
  try {
    const draft = await f.workspace.createDraft({ ...f.request, initialSelection: { codemapMode: 'manual',
      sources: [f.request.initialSelection.sources[1]!, f.request.initialSelection.sources[0]!, f.request.initialSelection.sources[2]!] } }, signal());
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    const loaded = await loadVerifiedBundle(ready.directory);
    const result = execFileSync(process.execPath, [resolve('dist/cli/main.js'), 'verify', '--bundle', ready.directory, '--mode', 'integrity'], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    assert.equal(JSON.parse(result).kind, 'verified');
    const originalHandoff = await readFile(join(ready.directory, 'handoff.md'), 'utf8');
    for (const kind of ['requested', 'ready', 'gitScope'] as const) {
      const manifest = structuredClone(ready.manifest); assert(manifest.manualPresentation);
      if (kind === 'gitScope') { assert(manifest.automaticGit); manifest.automaticGit.evidence.scope = 'selected'; }
      else manifest.manualPresentation[kind].pop();
      const handoff = kind === 'gitScope' ? originalHandoff.replace('"scope":"complete"', '"scope":"selected"') : renderBundle({ ...loaded, codemapMode: manifest.codemapMode, request: manifest.request, inventory: manifest.inventory,
        prompt: manifest.prompt, manualPresentation: manifest.manualPresentation,
        unavailableRoots: manifest.unavailableRoots, unavailableFiles: manifest.unavailableFiles,
        automaticAcquisition: { kind: 'settled', outcomes: manifest.automaticCodemaps }, clipboardPreset: manifest.clipboardPreset,
        selectedGitDiffIds: [], automaticGit: loaded.automaticGit }).handoff;
      manifest.files.handoff = identity(handoff);
      await writeFile(join(ready.directory, 'handoff.md'), handoff);
      await writeFile(join(ready.directory, 'manifest.json'), canonicalJSON(manifest));
      await assert.rejects(verifyBundle(ready.directory), /bundleIntegrityFailed|invalidClipboard/);
    }
    await writeFile(join(ready.directory, 'handoff.md'), originalHandoff);
    await writeFile(join(ready.directory, 'manifest.json'), canonicalJSON(ready.manifest));
    await verifyBundle(ready.directory);
    await writeFile('test-output/manual-native-free-integrity.json', JSON.stringify({ directory: ready.directory, nativeFreeVerified: true,
      rejectedForgeries: ['requested', 'ready', 'gitScope'] }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});

test('Manual complete Git rejects missing local comparison refs rather than substituting HEAD', async () => {
  const f = await fixture(manual('none', 'None', 'all'));
  try {
    const draft = await f.workspace.createDraft({ ...f.request, reviewGitBase: 'origin/missing' }, signal());
    await assert.rejects(draft.finalize(signal()), /gitQueryFailed|gitComparisonUnavailable|invalidGitComparison/);
  } finally { await f.runtime.close(); }
});

test('Manual reports required source/document conflicts before excluding or projecting their bodies', async () => {
  const preset = manual('selected');
  const f = await fixture(preset);
  try {
    const draft = await f.workspace.createDraft({ ...f.request, requiredSources: [f.request.initialSelection.sources[0]!] }, signal());
    await assert.rejects(draft.finalize(signal()), /copyPresetRequiredMaterialConflict/);
    const excluded = { ...preset, customizations: { ...preset.customizations, includeFiles: false } };
    const excludedFixture = await fixture(excluded);
    try {
      await assert.rejects(excludedFixture.workspace.createDraft({ ...excludedFixture.request,
        documents: [{ kind: 'suppliedDocument', id: 'doc', role: 'report', origin: 'fixture', text: 'REQUIRED DOCUMENT' }] }, signal()), /copyPresetRequiredMaterialConflict/);
    } finally { await excludedFixture.runtime.close(); }
  } finally { await f.runtime.close(); }
});

test('Manual selected replaces directly selected slices with a map and clears their ranges', async () => {
  const f = await fixture(manual('selected', 'None'));
  try {
    const draft = await f.workspace.createDraft({ ...f.request, initialSelection: { codemapMode: 'manual',
      sources: [f.request.initialSelection.sources[1]!, f.request.initialSelection.sources[0]!, f.request.initialSelection.sources[2]!] } }, signal());
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    const slice = ready.manifest.materials.find(record => record.kind === 'source' && record.selection.source.path === 'Slice.swift');
    assert(slice?.kind === 'source'); assert.equal(slice.selection.kind, 'codemap'); assert.deepEqual(slice.normalized, []);
    const context = await readFile(join(ready.directory, 'context.md'), 'utf8'); assert(!context.includes('(lines 2:'));
    assert(context.indexOf('File: r/Slice.swift') < context.indexOf('File: r/Full.swift'));
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
  } finally { await f.runtime.close(); }
});

test('Manual component tree costs follow captured inclusion, mode and global marker settings', async () => {
  for (const scenario of [
    { mode: 'None', include: null, disabled: false },
    { mode: 'Selected', include: null, disabled: false },
    { mode: 'Full', include: null, disabled: false },
    { mode: 'Full', include: false, disabled: false },
    { mode: 'Full', include: null, disabled: true },
  ] as const) {
    const context = manual('none', scenario.mode);
    context.customizations.includeFileTree = scenario.include;
    context.codeMapsGloballyDisabled = scenario.disabled;
    const f = await fixture(context);
    try {
      const draft = await f.workspace.createDraft(f.request, signal());
      const costs = await draft.inspect({ view: 'costs', maxOutputBytes: 100000, continuation: null }, signal());
      assert(costs.kind === 'costs');
      const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
      assert.equal(costs.token_stats?.file_tree ?? 0, Math.floor(ready.manifest.fileTree.span.length * 21 / 80),
        JSON.stringify(scenario));
    } finally { await f.runtime.close(); }
  }
});

test('Manual preview measures the proposed direct selection and leaves canonical membership unchanged', async () => {
  const f = await fixture(manual('selected', 'None'));
  try {
    const draft = await f.workspace.createDraft({ ...f.request, initialSelection: { codemapMode: 'manual', sources: [] } }, signal());
    const selection = f.request.initialSelection.sources[0]!;
    const preview = await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'preview',
      paths: [selection.source.root + '/' + selection.source.path], maxOutputBytes: 100000 })), signal());
    const comparison = await f.workspace.createDraft({ ...f.request, outputName: 'comparison', initialSelection: { codemapMode: 'manual', sources: [selection] } }, signal());
    const measured = await comparison.validate(signal());
    assert.deepEqual(preview.measurement, measured.measurement);
    assert.deepEqual(draft.selectionProjection().sources, []); assert.equal(draft.revision, 0);
  } finally { await f.runtime.close(); }
});

test('Manual complete presents supported unselected files across roots with no canonical or inferred membership', async () => {
  const f = await fixture(manual('complete', 'None'));
  try {
    const peer = join(f.root, '../peer'); await mkdir(peer); await writeFile(join(peer, 'Extra.swift'), 'struct ExtraManualMap { let value: Int }\n');
    const workspace = await f.runtime.declare({ roots: [{ name: 'r', absolutePath: f.root }, { name: 'z', absolutePath: peer }],
      exclusions: [], outputRoot: join(f.root, '../out') }, signal());
    const draft = await workspace.createDraft({ ...f.request, initialSelection: { codemapMode: 'automatic', sources: [] } }, signal());
    const before = draft.selectionProjection(), ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    const context = await readFile(join(ready.directory, 'context.md'), 'utf8'); assert(context.includes('File: z/Extra.swift'));
    assert(context.indexOf('File: z/Extra.swift') < context.indexOf('File: r/Other.swift'));
    assert(context.includes('File: r/Other.swift')); assert.deepEqual(draft.selectionProjection(), before);
    assert.deepEqual(ready.manifest.automaticCodemaps, []); assert.equal(ready.manifest.manualPresentation?.completeRootSet, true);
    assert(ready.manifest.materials.every(record => record.kind !== 'source' || record.selectionOrigin === 'presentation'));
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
    await writeFile('test-output/manual-complete-roots.json', JSON.stringify({ directory: ready.directory, manifest: ready.manifest }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});

test('Manual complete Git uses the explicit active repository, including a null root, independently of selection', async () => {
  const f = await fixture(manual('none', 'None', 'all'));
  try {
    const peer = join(f.root, '../peer'); await mkdir(peer);
    const run = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd: peer, encoding: 'utf8' });
    await writeFile(join(peer, 'peer.txt'), 'PEER BASE\n'); run(['init', '-q']); run(['add', '.']);
    run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'peer base']);
    await writeFile(join(peer, 'peer.txt'), 'EXPLICIT PEER CHANGE\n');
    for (const activeGitRoot of ['other', null]) {
      const preset = manual('none', 'None', 'all'); preset.activeGitRoot = activeGitRoot;
      const runtime = new SmipRuntime({ ...f.runtime.options, copyContext: preset });
      try {
      const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: f.root }, { name: 'other', absolutePath: peer }],
        exclusions: [], outputRoot: join(f.root, '../out') }, signal());
      const draft = await workspace.createDraft({ ...f.request, outputName: activeGitRoot ?? 'no-root' }, signal());
      const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
      const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
      assert.equal(context.includes('<git_diff>'), activeGitRoot !== null);
      if (activeGitRoot !== null) {
        const diff = context.slice(context.indexOf('<git_diff>')); assert(diff.includes('EXPLICIT PEER CHANGE')); assert(!diff.includes('FULL CHANGED'));
      }
      await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, runtime, signal());
      } finally { await runtime.close(); }
    }
  } finally { await f.runtime.close(); }
});
