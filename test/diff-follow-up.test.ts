import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { contextRequestValidator, type ContextBuildRequest } from '../src/contracts/context.js';
import { selectionValidator, type SelectionRequest } from '../src/contracts/selection.js';
import { gitValidator } from '../src/contracts/git.js';
import { canonicalJSON, sha256 } from '../src/workspace/values.js';

const signal = () => new AbortController().signal;
const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const units = (text: string) => Math.floor(Buffer.byteLength(text) * 21 / 80);
const task = 'Discuss only the selected changes.\nLiteral <user_instructions> & λ 🙂';
const role = { id: 'd7f1b2e4-3c5a-6b8d-cf8e-1f5d0e2a4c6b', title: 'Unselected review role', content: 'DO NOT INJECT THIS ROLE' };

async function fixture(mode: 'manual' | 'automatic' = 'manual') {
  const base = await mkdtemp(join(tmpdir(), 'smip-diff-follow-up-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  const files = { 'Full.swift': 'struct Full { let value: Map }\n', 'Slice.txt': 'first\nsecond\nthird\n',
    'Map.swift': 'struct Map { let value: Int }\n', 'Other.txt': 'unselected base\n' };
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  run(['add', '.']); run(['commit', '-qm', 'base']);
  await writeFile(join(root, 'Full.swift'), files['Full.swift'] + '// selected full change\n');
  await writeFile(join(root, 'Slice.txt'), 'changed outside slice\nsecond\nchanged after slice\n');
  await writeFile(join(root, 'Map.swift'), files['Map.swift'] + '// codemap-only change\n');
  await writeFile(join(root, 'Other.txt'), 'UNSELECTED CHANGE\n');
  const request = contextRequestValidator.Parse({ task, constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: mode, sources: [
      { kind: 'full', source: { root: 'r', path: 'Full.swift' } },
      { kind: 'slices', source: { root: 'r', path: 'Slice.txt' }, ranges: [{ start: 2, end: 2, description: 'Only the middle line' }] },
      ...(mode === 'manual' ? [{ kind: 'codemap', source: { root: 'r', path: 'Map.swift' } }] : []),
    ] }, requiredSources: [], documents: [], patches: [], copyPreset: 'diffFollowUp', storedPrompts: [role],
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: 'packet' });
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, git: { executable: git } });
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal());
  return { base, root, out, run, runtime, workspace, request };
}

for (const mode of ['manual', 'automatic'] as const) test(`Diff Follow-Up ${mode} exports scoped Git and literal instructions with exact costs`, async () => {
  const f = await fixture(mode);
  try {
    const draft = await f.workspace.createDraft(f.request, signal());
    const selection = await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'files', maxOutputBytes: 100000 })), signal());
    const before = draft.selectionProjection();
    const costs = await draft.inspect({ view: 'costs', maxOutputBytes: 100000, continuation: null }, signal());
    assert(costs.kind === 'costs'); assert(costs.measurement.complete);
    const validated = await draft.validate(signal()); assert.deepEqual(validated.measurement, costs.measurement);
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
    const diff = f.run(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', '--color=never', 'HEAD', '--', 'Full.swift', 'Slice.txt']);
    assert.equal(context, '<git_diff>\n' + diff + '\n</git_diff>\n<user_instructions>\n' + task + '\n</user_instructions>\n');
    assert.equal(costs.measurement.bytes, Buffer.byteLength(context)); assert.equal(costs.measurement.units, units(context));
    assert.deepEqual(costs.items, [{ id: 'automaticReviewGit', bytes: Buffer.byteLength(diff), units: units(diff) }]);
    assert.equal(costs.measurement.fixedOverhead.bytes, Buffer.byteLength(context) - Buffer.byteLength(diff));
    assert.equal(ready.manifest.accounting.bytes, costs.measurement.bytes);
    assert.deepEqual(draft.selectionProjection(), before); assert.equal(draft.revision, selection.revision);
    assert.deepEqual(ready.manifest.materials, []); assert.deepEqual(ready.manifest.automaticCodemaps, []);
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
    const terminal = await draft.inspect({ view: 'costs', maxOutputBytes: 100000, continuation: null }, signal());
    assert(terminal.kind === 'costs'); assert.deepEqual(terminal.measurement, costs.measurement);
    await writeFile(join(f.root, 'Full.swift'), 'changed after publication\n');
    await verifyBundle(ready.directory);
    await assert.rejects(verifyCurrentBundle(ready.directory, f.runtime, signal()), /sourceChanged|automaticGitChanged/);
    await writeFile(`test-output/diff-follow-up-${mode}.json`, JSON.stringify({ directory: ready.directory, selection, costs,
      manifest: ready.manifest, savedVerifiedAfterSourceChange: true }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});

test('Diff Follow-Up selected patch takes precedence, omits selected MAP and preserves complete required patches', async () => {
  const f = await fixture();
  try {
    const requiredBody = 'EXACT REQUIRED PATCH\n```\nλ\n';
    const request: ContextBuildRequest = { ...f.request, patches: [{ kind: 'suppliedPatch', id: 'required', root: 'r',
      text: requiredBody, origin: 'fixture', comparison: { kind: 'supplied', base: 'before', target: 'after' }, coverage: [], targets: [] }] };
    const draft = await f.workspace.createDraft(request, signal());
    const diff = gitValidator.Parse(gitValidator.Default({ op: 'diff', maxOutputBytes: 100000 })); assert(diff.op === 'diff');
    const published = await draft.publishGitSnapshot(diff, { mode: 'standard', scope: 'all', snapshotID: 'selected',
      inlineMap: true, inlineMode: 'brief', inlineMaxLines: 120 }, signal()); assert(published.kind === 'single');
    const [map, patch] = published.projection.primarySelectionAliases; assert(map && patch);
    const select = (input: Partial<SelectionRequest>) => draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ maxOutputBytes: 100000, ...input })), signal());
    await select({ op: 'add', paths: [map, patch], strict: true });
    const selected = await select({ op: 'get', view: 'files' }), before = draft.selectionProjection();
    const patchText = await readFile(join(f.out, patch), 'utf8');
    // The selected artifact retains its snapshot when another workspace path changes.
    await writeFile(join(f.root, 'Other.txt'), 'LATER UNSELECTED CHANGE\n');
    const costs = await draft.inspect({ view: 'costs', maxOutputBytes: 100000, continuation: null }, signal()); assert(costs.kind === 'costs');
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
    assert.equal(context, '<git_diff>\n' + patchText + '\n\n' + requiredBody + '\n</git_diff>\n<user_instructions>\n' + task + '\n</user_instructions>\n');
    assert.equal(ready.manifest.automaticGit, null);
    assert.deepEqual(ready.manifest.materials.map(material => material.kind), ['gitPatch', 'patch']);
    assert.deepEqual(costs.items, [{ id: 'gitArtifact:' + patch, bytes: Buffer.byteLength(patchText), units: units(patchText) },
      { id: 'patch:required', bytes: Buffer.byteLength(requiredBody), units: units(requiredBody) }]);
    assert.equal(costs.measurement.bytes, Buffer.byteLength(context)); assert.equal(costs.measurement.units, units(context));
    assert.deepEqual(draft.selectionProjection(), before); assert.equal(draft.revision, selected.revision);
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
    const mapBody = await draft.inspect({ view: 'material', materialId: 'gitArtifact:' + map, maxOutputBytes: 100000, continuation: null }, signal());
    assert('lines' in mapBody); assert.equal(mapBody.lines.map(line => line.text).join(''), await readFile(join(f.out, map), 'utf8'));
    await writeFile('test-output/diff-follow-up-selected.json', JSON.stringify({ directory: ready.directory, selected, costs, manifest: ready.manifest }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});

test('Diff Follow-Up reports conflicts with required sources and documents instead of dropping them', async () => {
  const f = await fixture();
  try {
    for (const selection of f.request.initialSelection.sources) {
      await assert.rejects(f.workspace.createDraft({ ...f.request, requiredSources: [selection] }, signal()), /copyPresetRequiredMaterialConflict/);
    }
    for (const document of [
      { kind: 'suppliedDocument' as const, id: 'report', role: 'report' as const, origin: 'fixture', text: 'REQUIRED REPORT' },
      { kind: 'localDocument' as const, id: 'local', role: 'evidence' as const, source: { root: 'r', path: 'Other.txt' } },
    ]) await assert.rejects(f.workspace.createDraft({ ...f.request, documents: [document] }, signal()), /copyPresetRequiredMaterialConflict/);
    const draft = await f.workspace.createDraft(f.request, signal());
    await assert.rejects(draft.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'addDocument',
      document: { kind: 'suppliedDocument', id: 'later', role: 'report', origin: 'fixture', text: 'RETAIN THIS REPORT' } } }, signal()), /copyPresetRequiredMaterialConflict/);
    assert.equal(draft.revision, 0);
    await draft.close();
  } finally { await f.runtime.close(); }
});

test('saved Diff Follow-Up rejects excluded codemap membership that cannot explain its automatic Git scope', async () => {
  const f = await fixture();
  try {
    const draft = await f.workspace.createDraft(f.request, signal());
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    await verifyBundle(ready.directory);
    const directory = join(f.base, 'forged'); await mkdir(directory);
    const originalHandoff = await readFile(join(ready.directory, 'handoff.md'), 'utf8');
    const manifest = structuredClone(ready.manifest);
    assert(manifest.manualPresentation);
    const index = manifest.manualPresentation.canonicalSources.findIndex(selection => selection.source.path === 'Full.swift'); assert(index >= 0);
    manifest.manualPresentation.canonicalSources[index] = { kind: 'codemap', source: { root: 'r', path: 'Full.swift' } };
    const handoff = originalHandoff.replace('"manualPresentation":' + canonicalJSON(ready.manifest.manualPresentation),
      '"manualPresentation":' + canonicalJSON(manifest.manualPresentation));
    assert.notEqual(handoff, originalHandoff);
    manifest.files.handoff = { sha256: sha256(handoff), byteCount: Buffer.byteLength(handoff) };
    await writeFile(join(directory, 'context.md'), await readFile(join(ready.directory, 'context.md')));
    await writeFile(join(directory, 'handoff.md'), handoff); await writeFile(join(directory, 'manifest.json'), canonicalJSON(manifest));
    await assert.rejects(verifyBundle(directory), /bundleIntegrityFailed/);
  } finally { await f.runtime.close(); }
});
