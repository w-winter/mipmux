import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { ContextBuildRequest } from '../src/contracts/context.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { gitValidator } from '../src/contracts/git.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import { SmipRuntime, type RuntimeOptions } from '../src/runtime/smip-runtime.js';

const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;
const metadata = Compile(Type.Object({ snapshotID: Type.String(), repoKey: Type.String(), repoRoot: Type.String(),
  tabID: Type.String(), generatedAt: Type.String(), scope: Type.String(), compare: Type.String() }));
type PublicationFailure = 'write' | 'current' | 'revision' | 'cancel';

function interruptedRuntime(options: RuntimeOptions, failure: PublicationFailure, effect: () => Promise<void>) {
  let interrupt = false;
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (interrupt && failure === 'write' && operation.kind === 'writeGitSnapshotFile' && operation.path === 'MAP.txt') {
            interrupt = false; throw new NativeFailure('nativeIOFailed', 28);
          }
          if (interrupt && failure === 'current' && operation.kind === 'writeGitSnapshotCurrent') {
            interrupt = false; throw new NativeFailure('nativeIOFailed', 28);
          }
          const result = await super.request(operation, requestSignal);
          if (interrupt && operation.kind === 'maintainGitSnapshots' && operation.action.kind === 'published') {
            interrupt = false; await effect();
          }
          return result;
        }
      }
      return new Bridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
    }
  }
  return { runtime: new Runtime(options), arm: () => { interrupt = true; } };
}

async function assertRetainedFiles(output: string, snapshotID: string, failure: PublicationFailure) {
  const repos = join(output, '_git_data/repos'), [repoKey] = await readdir(repos); assert(repoKey);
  const directory = join(repos, repoKey, snapshotID);
  assert((await readFile(join(directory, 'manifest.json'), 'utf8')).includes(snapshotID));
  if (failure !== 'write') assert((await readFile(join(directory, 'MAP.txt'), 'utf8')).includes(snapshotID));
  if (failure === 'revision' || failure === 'cancel') assert.equal(await readlink(join(repos, repoKey, 'CURRENT')), snapshotID);
}

async function fixture() {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-publish-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await writeFile(join(root, 'file.txt'), 'base\n');
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  run(['add', '.']); run(['commit', '-qm', 'base']); await writeFile(join(root, 'file.txt'), 'changed\n');
  const request: ContextBuildRequest = { task: 'Collect evidence', constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } }] },
    requiredSources: [], documents: [], patches: [], copyPreset: 'standard',
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: 'packet' };
  const diff = gitValidator.Parse(gitValidator.Default({ op: 'diff', maxOutputBytes: 1 })); assert(diff.op === 'diff');
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000, git: { executable: git } };
  return { base, root, out, options, request, diff, run };
}

test('draft publication persists complete source snapshots, CURRENT and projected aliases for all modes', async () => {
  const f = await fixture(), runtime = new SmipRuntime(f.options), proof: unknown[] = [];
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.out }, signal());
    const draft = await workspace.createDraft(f.request, signal());
    for (const mode of ['quick', 'standard', 'deep'] as const) {
      const publication = await draft.publishGitSnapshot(f.diff, { mode, scope: 'all', snapshotID: mode,
        inlineMap: true, inlineMode: 'brief', inlineMaxLines: 120 }, signal());
      assert(publication.kind === 'single');
      const directory = join(f.out, '_git_data', publication.snapshotDir);
      const saved = metadata.Parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
      assert.equal(saved.tabID.toLowerCase(), draft.id); assert.equal(saved.repoRoot, publication.checkout.checkoutRootPath);
      assert.equal(saved.repoKey, publication.checkout.repoKey); assert.equal(saved.scope, 'all');
      assert.equal(await readlink(join(directory, '../CURRENT')), mode);
      for (const file of publication.files) assert.deepEqual(await readFile(join(directory, file.path)), Buffer.from(file.bytes, 'base64'));
      assert.equal(publication.projection.reply.snapshot_id, mode);
      assert.equal(publication.projection.reply.primary_artifacts.map, '_git_data/' + publication.snapshotDir + '/MAP.txt');
      assert((await readFile(join(directory, 'MAP.txt'), 'utf8')).includes(f.run(['log', '--graph', '--decorate', '--oneline', '--color=never', '-n', '20']).trim()));
      if (mode !== 'quick') assert((await readFile(join(directory, 'diff/all.patch'), 'utf8')).includes('-base\n+changed\n'));
      else assert(!(await readdir(directory)).includes('diff'));
      if (mode === 'deep') assert((await readdir(join(directory, 'deep'))).includes('hunks.jsonl'));
      proof.push({ mode, publication, saved });
    }
    const automatic = await draft.publishGitSnapshot(f.diff, { mode: 'standard', scope: 'all', snapshotID: null,
      inlineMap: false, inlineMode: 'brief', inlineMaxLines: 120 }, signal());
    assert(automatic.kind === 'single');
    const collided = await draft.publishGitSnapshot(f.diff, { mode: 'standard', scope: 'all', snapshotID: null,
      inlineMap: false, inlineMode: 'brief', inlineMaxLines: 120 }, signal());
    assert(collided.kind === 'single');
    assert.notEqual(automatic.snapshotID, collided.snapshotID);
    await draft.close(); await workspace.close();
    await writeFile('test-output/git-publication-proof.json', JSON.stringify({ proof, automatic: automatic.snapshotID,
      collision: collided.snapshotID, replyCapDoesNotTruncateSavedEvidence: true }, null, 2) + '\n');
  } finally { await runtime.close(); }
});

test('publication retains completed files on I/O/cancellation failure and admits concurrent prompt edits', async () => {
  for (const failure of ['write', 'current', 'revision', 'cancel'] as const) {
    const snapshotID = failure + '-failure';
    const f = await fixture(), resume = { effect: async () => {} };
    const { runtime, arm } = interruptedRuntime(f.options, failure, () => resume.effect());
    try {
      const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.out }, signal());
      const draft = await workspace.createDraft(f.request, signal()), controller = new AbortController();
      resume.effect = failure === 'cancel' ? async () => { controller.abort(); } : async () => {
        await draft.prompt({ expectedRevision: 0, maxOutputBytes: 100000, op: 'append', text: '\nChanged'  }, signal());
      };
      arm();
      const pending = draft.publishGitSnapshot(f.diff, { mode: 'standard', scope: 'all', snapshotID,
        inlineMap: true, inlineMode: 'brief', inlineMaxLines: 120 }, controller.signal);
      if (failure === 'revision') {
        const published = await pending; assert.equal(published.kind, 'single');
        assert.equal(draft.revision, 1);
        const prompt = await draft.prompt({ op: 'get', maxOutputBytes: 100000 }, signal());
        assert('prompt' in prompt); assert.equal(prompt.prompt, 'Collect evidence\nChanged');
        assert((await draft.readGitArtifact(published.projection.primarySelectionAliases[0]!, signal())).text.includes(snapshotID));
      } else await assert.rejects(pending, failure === 'cancel' ? /cancelled|aborted/i : /nativeIOFailed/);
      await assertRetainedFiles(f.out, snapshotID, failure);
      await draft.close(); await workspace.close();
    } finally { await runtime.close(); }
  }
});

test('selected publication uses full and sliced membership, literal paths and explicit-path precedence', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'slice.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(f.root, 'literal[ab].txt'), 'literal base\n');
  await writeFile(join(f.root, 'literalb.txt'), 'glob base\n');
  await writeFile(join(f.root, 'code.swift'), 'struct Example {}\n');
  f.run(['add', '.']); f.run(['commit', '-qm', 'selection inputs']);
  await writeFile(join(f.root, 'file.txt'), 'whole changed\n');
  await writeFile(join(f.root, 'slice.txt'), 'one\nchanged two\nchanged three\n');
  await writeFile(join(f.root, 'literal[ab].txt'), 'literal changed\n');
  await writeFile(join(f.root, 'literalb.txt'), 'glob changed\n');
  await writeFile(join(f.root, 'code.swift'), 'struct Example { let value = 1 }\n');
  await writeFile(join(f.root, 'new[ab].txt'), 'new literal\n');
  await writeFile(join(f.root, 'newb.txt'), 'new glob\n');
  const runtime = new SmipRuntime(f.options);
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.out }, signal());
    const draft = await workspace.createDraft({ ...f.request, initialSelection: { codemapMode: 'manual', sources: [
      { kind: 'full', source: { root: 'r', path: 'file.txt' } },
      { kind: 'slices', source: { root: 'r', path: 'slice.txt' }, ranges: [{ start: 2, end: 2, description: null }] },
      { kind: 'full', source: { root: 'r', path: 'literal[ab].txt' } },
      { kind: 'full', source: { root: 'r', path: 'new[ab].txt' } },
      { kind: 'codemap', source: { root: 'r', path: 'code.swift' } },
    ] } }, signal());
    const options = { scope: 'selected' as const, mode: 'standard' as const, snapshotID: 'selected',
      inlineMap: true, inlineMode: 'brief', inlineMaxLines: 120 };
    const selected = await draft.publishGitSnapshot(f.diff, options, signal());
    assert(selected.kind === 'single');
    const selectedManifest = JSON.parse(await readFile(join(f.out, '_git_data', selected.snapshotDir, 'manifest.json'), 'utf8'));
    assert.equal(selectedManifest.scope, 'selected');
    assert.deepEqual(selectedManifest.requestedPaths, ['file.txt', 'literal[ab].txt', 'new[ab].txt', 'slice.txt']);
    assert.equal(selected.projection.reply.summary.files, 4);
    const patch = await readFile(join(f.out, '_git_data', selected.snapshotDir, 'diff/all.patch'), 'utf8');
    assert(patch.includes('+changed three')); assert(patch.includes('+literal changed'));
    assert(patch.includes('+new literal')); assert(!patch.includes('+new glob'));
    assert(!patch.includes('+glob changed')); assert(!patch.includes('let value'));
    const explicit = await draft.publishGitSnapshot({ ...f.diff, paths: ['literalb.txt'] }, { ...options, snapshotID: 'explicit' }, signal());
    assert(explicit.kind === 'single');
    assert.equal(explicit.projection.reply.summary.files, 1);
    assert.equal(await readFile(join(f.out, '_git_data', explicit.snapshotDir, 'index/selection.paths.txt'), 'utf8'), 'literalb.txt');
    await draft.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'remove', source: { root: 'r', path: 'literal[ab].txt' } } }, signal());
    const current = await draft.publishGitSnapshot(f.diff, { ...options, snapshotID: 'current-selection' }, signal());
    assert(current.kind === 'single');
    assert.equal(current.projection.reply.summary.files, 3);
    await writeFile('test-output/git-selected-publication-proof.json', JSON.stringify({ selected, selectedManifest, explicit, current,
      slicedSourceUsesWholeDiff: true, codemapExcluded: true, literalNamesPreserved: true }, null, 2) + '\n');
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});
