import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle, type ContextBuildRequest } from '../src/index.js';
import { gitValidator } from '../src/contracts/git.js';
import { selectionValidator, type SelectionRequest } from '../src/contracts/selection.js';

const signal = () => new AbortController().signal;
const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'smip-git-selection-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'file.txt'), 'base\n'); run(['add', '.']); run(['commit', '-qm', 'base']);
  await writeFile(join(root, 'file.txt'), 'changed\n');
  const request: ContextBuildRequest = { task: 'Retain exact historical evidence', constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } }] },
    requiredSources: [], documents: [], patches: [], copyPreset: 'standard', storedPrompts: [],
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: 'packet' };
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000, git: { executable: git } });
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal());
  const draft = await workspace.createDraft(request, signal());
  const diff = gitValidator.Parse(gitValidator.Default({ op: 'diff', maxOutputBytes: 100000 })); assert(diff.op === 'diff');
  const options = { mode: 'standard' as const, scope: 'all' as const, snapshotID: 'first',
    inlineMap: true, inlineMode: 'brief', inlineMaxLines: 120 };
  const select = (input: Partial<SelectionRequest>) => draft.manageSelection(
    selectionValidator.Parse(selectionValidator.Default({ maxOutputBytes: 100000, view: 'files', ...input })), signal());
  return { root, out, runtime, workspace, draft, diff, options, run, select };
}

test('mutable exact Git aliases retain historical export order, MAP framing and saved/current verification', async () => {
  const f = await fixture();
  try {
    const first = await f.draft.publishGitSnapshot(f.diff, f.options, signal()); assert(first.kind === 'single');
    const [map, whole] = first.projection.primarySelectionAliases, perFile = first.projection.advertisedSelectionAliases[2];
    assert(map && whole && perFile);
    const selected = [map, perFile, whole];
    const preview = await f.select({ op: 'preview', paths: selected });
    assert.equal(preview.revision, 0); assert.deepEqual(preview.files.map(file => file.path), selected);
    assert.equal((await f.select({ op: 'get' })).files.length, 1);
    const added = await f.select({ op: 'set', paths: selected, strict: true });
    assert.equal(added.revision, 1); assert.equal(added.codemap_auto_enabled, false);
    assert.deepEqual(added.files.map(file => file.path), selected);
    const mapText = await readFile(join(f.out, map), 'utf8'), perFileText = await readFile(join(f.out, perFile), 'utf8');
    const wholeText = await readFile(join(f.out, whole), 'utf8');
    const manifestPath = join(f.out, '_git_data', first.snapshotDir, 'manifest.json');
    const manifestBytes = await readFile(manifestPath);
    await unlink(manifestPath);
    await assert.rejects(f.draft.publishGitSnapshot(f.diff, { ...f.options, snapshotID: 'unreadable-owner' }, signal()), /gitSelectionOwnershipChanged|notFound|gitArtifactUnauthorized/);
    await writeFile(manifestPath, manifestBytes);
    f.run(['add', '.']); f.run(['commit', '-qm', 'later HEAD']); await writeFile(join(f.root, 'file.txt'), 'later working tree\n');
    const second = await f.draft.publishGitSnapshot(f.diff, { ...f.options, snapshotID: 'second' }, signal());
    assert(second.kind === 'single');
    await assert.rejects(f.select({ op: 'set', paths: [map] }), /invalidSelection/);
    assert.equal(f.draft.revision, 1);
    const removed = await f.select({ op: 'remove', paths: [whole], strict: true }); assert.equal(removed.revision, 2);
    assert.deepEqual(removed.files.map(file => file.path), [map, perFile]);
    const readd = await f.select({ op: 'add', paths: [whole], strict: false });
    assert.equal(readd.revision, 2); assert(readd.invalid_paths?.some(path => path.includes(whole)));
    const mapBody = (await f.select({ op: 'get', view: 'content' })).blocks?.join('\n'); assert(mapBody?.includes(mapText));
    const finalized = await f.draft.finalize(signal()); assert(finalized.kind === 'ready');
    const context = await readFile(join(finalized.directory, 'context.md'), 'utf8');
    assert(context.includes('File: ' + map + '\n```txt\n' + mapText + '\n```'));
    assert(context.includes('<git_diff>\n' + perFileText + '\n</git_diff>'));
    assert(!context.includes(wholeText + '\n\n' + wholeText));
    assert.equal(finalized.manifest.materials.length, 2);
    await verifyBundle(finalized.directory); await verifyCurrentBundle(finalized.directory, f.runtime, signal());
    const deniedRuntime = new SmipRuntime({ ...f.runtime.options, credentialPaths: [f.out] });
    try { await assert.rejects(verifyCurrentBundle(finalized.directory, deniedRuntime, signal()), /pathDenied/); }
    finally { await deniedRuntime.close(); }
    await writeFile('test-output/git-artifact-selection-proof.json', JSON.stringify({ directory: finalized.directory,
      selected, removedWholePatch: true, historicalMap: mapText, historicalPatch: perFileText,
      laterSnapshot: second.snapshotDir, savedAndCurrentVerified: true }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});

test('selected patches preserve duplicate content, alias restrictions and commit-before-reply settlement', async () => {
  const f = await fixture();
  try {
    const published = await f.draft.publishGitSnapshot(f.diff, f.options, signal()); assert(published.kind === 'single');
    const [map, whole] = published.projection.primarySelectionAliases, perFile = published.projection.advertisedSelectionAliases[2];
    assert(map && whole && perFile);
    for (const input of [{ op: 'add', mode: 'codemap_only', paths: [map], strict: true },
      { op: 'set', mode: 'slices', paths: [map] }, { op: 'promote', paths: [map] },
      { op: 'set', paths: [map + '#L1-2'] }]) {
      await assert.rejects(f.select(selectionValidator.Parse(selectionValidator.Default({ ...input, maxOutputBytes: 100000 }))), /invalidSelection/);
    }
    assert.equal(f.draft.revision, 0);
    await assert.rejects(f.select({ op: 'add', paths: [whole, perFile], maxOutputBytes: 1 }), /outputBudgetTooSmall/);
    assert.equal(f.draft.revision, 1);
    assert.deepEqual((await f.select({ op: 'get' })).files.map(file => file.path), ['file.txt', whole, perFile]);
    await f.select({ op: 'remove', paths: ['file.txt'], strict: true });
    assert.equal((await f.select({ op: 'clear', mode: 'codemap_only' })).files.length, 2);
    assert.equal((await f.select({ op: 'clear' })).files.length, 0);
    await f.select({ op: 'add', paths: [whole, perFile], strict: true });
    const ready = await f.draft.finalize(signal()); assert(ready.kind === 'ready');
    const body = await readFile(join(f.out, whole), 'utf8'), perFileBody = await readFile(join(f.out, perFile), 'utf8');
    const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
    assert(context.includes('<git_diff>\n' + body + '\n\n' + perFileBody + '\n</git_diff>'));
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
  } finally { await f.runtime.close(); }
});
