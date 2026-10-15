import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle, type ContextBuildRequest } from '../src/index.js';
import { gitValidator } from '../src/contracts/git.js';
import { selectionValidator, type SelectionRequest } from '../src/contracts/selection.js';
import type { RuntimeOptions } from '../src/runtime/smip-runtime.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { BridgeClient } from '../src/native/bridge-client.js';

const signal = () => new AbortController().signal;
const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');

async function fixture(makeRuntime: (options: RuntimeOptions) => SmipRuntime = options => new SmipRuntime(options),
  presentation: Pick<ContextBuildRequest, 'copyPreset' | 'patches'> = { copyPreset: 'codeReview', patches: [] }) {
  const base = await mkdtemp(join(tmpdir(), 'smip-git-selection-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'file.txt'), 'base\n'); run(['add', '.']); run(['commit', '-qm', 'base']);
  await writeFile(join(root, 'file.txt'), 'changed\n');
  const request: ContextBuildRequest = { task: 'Retain exact historical evidence', constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } }] },
    requiredSources: [], documents: [], ...presentation, storedPrompts: [],
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: 'packet' };
  const runtime = makeRuntime({ cachePath: join(base, 'cache'),
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

for (const copyPreset of ['standard', 'plan', 'codeReview'] as const) {
  for (const required of [false, true]) test(`${copyPreset} Git export respects inclusion ${required ? 'with' : 'without'} caller-required evidence`, async () => {
    const requiredBody = 'CALLER REQUIRED PATCH\n';
    const f = await fixture(undefined, { copyPreset, patches: required ? [{ kind: 'suppliedPatch', id: 'required', root: 'r',
      text: requiredBody, origin: 'fixture', comparison: { kind: 'supplied', base: 'before', target: 'after' }, coverage: [], targets: [] }] : [] });
    try {
      const published = await f.draft.publishGitSnapshot(f.diff, f.options, signal()); assert(published.kind === 'single');
      const [map, patch] = published.projection.primarySelectionAliases; assert(map && patch);
      await f.select({ op: 'set', paths: [map, patch], strict: true });
      const patchText = await readFile(join(f.out, patch), 'utf8');
      const selection = await f.select({ op: 'get', view: 'content' });
      assert(selection.blocks?.join('\n').includes(patchText));
      const costs = await f.draft.inspect({ view: 'costs', maxOutputBytes: 100000, continuation: null }, signal());
      assert(costs.kind === 'costs');
      const includesSelectedPatch = copyPreset === 'codeReview';
      assert.equal(costs.items.some(cost => 'id' in cost && cost.id === 'gitArtifact:' + patch), includesSelectedPatch);
      const ready = await f.draft.finalize(signal()); assert(ready.kind === 'ready');
      const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
      const expectedDiff = [includesSelectedPatch ? patchText : '', required ? requiredBody : ''].filter(Boolean).join('\n\n');
      assert.equal(context.includes('<git_diff>'), !!expectedDiff);
      if (expectedDiff) assert(context.includes('<git_diff>\n' + expectedDiff + '\n</git_diff>'));
      assert(context.includes('File: ' + map + '\n```txt\n' + await readFile(join(f.out, map), 'utf8') + '\n```'));
      assert.equal(ready.manifest.materials.some(material => material.kind === 'gitPatch'), includesSelectedPatch);
      assert.equal(ready.manifest.materials.some(material => material.kind === 'patch'), required);
      assert.equal(costs.measurement.bytes, Buffer.byteLength(context));
      assert.equal(costs.measurement.units, ready.manifest.accounting.units);
      await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
      const inspected = await f.draft.inspect({ view: 'material', materialId: 'gitArtifact:' + patch,
        maxOutputBytes: 100000, continuation: null }, signal());
      assert('lines' in inspected); assert.equal(inspected.lines.map(line => line.text).join(''), patchText);
      await writeFile(`test-output/git-preset-${copyPreset}-${required}.json`, JSON.stringify({ directory: ready.directory,
        selection: selection.files, includesSelectedPatch, required, costs, manifest: ready.manifest }, null, 2) + '\n');
    } finally { await f.runtime.close(); }
  });
}

test('whitespace-only selected patches are omitted without losing inspection or required evidence', async () => {
  for (const [body, required] of [[' \t\r\n', false], ['\u0085\u2028', true]] as const) {
    const requiredBody = 'REQUIRED EVEN WITH EMPTY OPTIONAL PATCH\n';
    const f = await fixture(undefined, { copyPreset: 'codeReview', patches: required ? [{ kind: 'suppliedPatch', id: 'required', root: 'r',
      text: requiredBody, origin: 'fixture', comparison: { kind: 'supplied', base: 'before', target: 'after' }, coverage: [], targets: [] }] : [] });
    try {
      const published = await f.draft.publishGitSnapshot(f.diff, f.options, signal()); assert(published.kind === 'single');
      const [map, patch] = published.projection.primarySelectionAliases; assert(map && patch);
      await f.select({ op: 'set', paths: [map, patch], strict: true });
      await writeFile(join(f.out, patch), body);
      const costs = await f.draft.inspect({ view: 'costs', maxOutputBytes: 100000, continuation: null }, signal());
      assert(costs.kind === 'costs');
      assert(!costs.items.some(cost => 'id' in cost && cost.id === 'gitArtifact:' + patch));
      const ready = await f.draft.finalize(signal()); assert(ready.kind === 'ready');
      const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
      assert.equal(context.includes('<git_diff>'), required);
      if (required) assert(context.includes('<git_diff>\n' + requiredBody + '\n</git_diff>'));
      assert(!ready.manifest.materials.some(material => material.kind === 'gitPatch'));
      assert.equal(costs.measurement.bytes, Buffer.byteLength(context));
      const inspected = await f.draft.inspect({ view: 'material', materialId: 'gitArtifact:' + patch,
        maxOutputBytes: 100000, continuation: null }, signal());
      assert('lines' in inspected); assert.equal(inspected.lines.map(line => line.text).join(''), body);
      await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
      await writeFile(`test-output/git-blank-patch-${required}.json`, JSON.stringify({ directory: ready.directory,
        body, required, costs, manifest: ready.manifest }, null, 2) + '\n');
    } finally { await f.runtime.close(); }
  }
});

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

test('live artifact observations and export reacquire overwritten snapshots while terminal inspection retains delivered bytes', async () => {
  const f = await fixture();
  try {
    const first = await f.draft.publishGitSnapshot(f.diff, f.options, signal()); assert(first.kind === 'single');
    const [map, patch] = first.projection.primarySelectionAliases; assert(map && patch);
    await f.select({ op: 'set', paths: [map, patch], strict: true });
    const initial = await f.draft.inspect({ view: 'costs', maxOutputBytes: 100000, continuation: null }, signal());
    await writeFile(join(f.root, 'file.txt'), 'replacement snapshot\n' + 'Additional evidence.\n'.repeat(200));
    const overwritten = await f.draft.publishGitSnapshot(f.diff, f.options, signal()); assert(overwritten.kind === 'single');
    const mapText = await readFile(join(f.out, map), 'utf8'), patchText = await readFile(join(f.out, patch), 'utf8');
    const current = await f.select({ op: 'get', view: 'content' });
    assert(current.blocks?.join('\n').includes(patchText)); assert(current.blocks?.join('\n').includes(mapText));
    assert.equal(f.draft.revision, 1);
    const material = await f.draft.inspect({ view: 'material', materialId: 'gitArtifact:' + patch,
      maxOutputBytes: 100000, continuation: null }, signal());
    assert('lines' in material); assert.equal(material.lines.map(line => line.text).join(''), patchText);
    const costs = await f.draft.inspect({ view: 'costs', maxOutputBytes: 100000, continuation: null }, signal());
    assert('measurement' in costs && 'measurement' in initial); assert(costs.measurement.bytes > initial.measurement.bytes);
    const preview = await f.draft.preview({ expectedRevision: 1, maxOutputBytes: 100000,
      edits: [{ kind: 'remove', source: { root: 'r', path: 'file.txt' } }] }, signal());
    assert.equal(preview.measurement.bytes, costs.measurement.bytes);
    const validated = await f.draft.validate(signal()); assert.equal(validated.measurement.bytes, costs.measurement.bytes);
    const ready = await f.draft.finalize(signal()); assert(ready.kind === 'ready');
    const delivered = await readFile(join(ready.directory, 'context.md'), 'utf8');
    assert(delivered.includes('<git_diff>\n' + patchText + '\n</git_diff>'));
    assert(delivered.includes('File: ' + map + '\n```txt\n' + mapText + '\n```'));
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
    await writeFile(join(f.out, patch), 'changed after delivery\n');
    const terminal = await f.draft.inspect({ view: 'material', materialId: 'gitArtifact:' + patch,
      maxOutputBytes: 100000, continuation: null }, signal());
    assert('lines' in terminal); assert.equal(terminal.lines.map(line => line.text).join(''), patchText);
    await verifyBundle(ready.directory);
    await assert.rejects(verifyCurrentBundle(ready.directory, f.runtime, signal()), /materialChanged/);
    await writeFile('test-output/git-artifact-refresh-proof.json', JSON.stringify({ directory: ready.directory,
      revision: f.draft.revision, mapText, patchText, bytes: ready.manifest.accounting.bytes,
      terminalRetainsDeliveredBody: true, savedIntegritySurvivesExternalChanges: true, currentDetectsExternalChanges: true }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});

test('artifact refresh cancellation and changed export inputs reject without publishing a packet', async () => {
  for (const effect of ['cancelRefresh', 'changeAfterWrite'] as const) {
    const controller = new AbortController();
    let armed = false, alter: () => Promise<void> = async () => {};
    const f = await fixture(options => {
      class Runtime extends SmipRuntime {
        override makeBridge() {
          class Bridge extends BridgeClient {
            override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
              if (armed && effect === 'cancelRefresh' && operation.kind === 'authorizeGitArtifact') {
                armed = false; controller.abort();
              }
              const result = await super.request(operation, requestSignal);
              if (armed && effect === 'changeAfterWrite' && operation.kind === 'writeExport') {
                armed = false; await alter();
              }
              return result;
            }
          }
          return new Bridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
        }
      }
      return new Runtime(options);
    });
    try {
      const published = await f.draft.publishGitSnapshot(f.diff, f.options, signal()); assert(published.kind === 'single');
      const patch = published.projection.primarySelectionAliases[1]; assert(patch);
      await f.select({ op: 'set', paths: [patch], strict: true });
      alter = () => writeFile(join(f.out, patch), 'changed while exporting\n');
      armed = true;
      if (effect === 'cancelRefresh') {
        const input = selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'content', maxOutputBytes: 100000 }));
        await assert.rejects(f.draft.manageSelection(input, controller.signal), /cancelled|aborted/i);
        assert.equal(f.draft.revision, 1); assert.equal((await f.select({ op: 'get' })).files[0]?.path, patch);
      } else await assert.rejects(f.draft.finalize(signal()), /materialChanged/);
      await assert.rejects(readFile(join(f.out, 'packet/manifest.json')), /ENOENT/);
    } finally { await f.runtime.close(); }
  }
});
