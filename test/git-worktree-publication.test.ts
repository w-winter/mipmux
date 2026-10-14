import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { ContextBuildRequest } from '../src/contracts/context.js';
import { gitValidator } from '../src/contracts/git.js';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import type { OwnedProcess, ProcessSpec } from '../src/runtime/process-supervisor.js';

const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;
const manifest = Compile(Type.Object({ isWorktree: Type.Boolean(), mainWorktreeRoot: Type.Optional(Type.String()) }));

async function fixture(separateGitDirectory: boolean) {
  const base = await mkdtemp(join(tmpdir(), 'smip-worktree-reply-')), main = join(base, 'main'), linked = join(base, 'linked');
  const output = join(base, 'out'); await mkdir(main); await mkdir(output);
  const run = (cwd: string, args: string[]) => execFileSync(git, args, { cwd, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(main, ['init', '-q', '-b', 'main', ...(separateGitDirectory ? ['--separate-git-dir', join(base, 'gitstore')] : [])]);
  if (separateGitDirectory) run(main, ['config', 'core.worktree', main]);
  run(main, ['config', 'user.name', 'Fixture']); run(main, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(main, 'file.txt'), 'base\n'); run(main, ['add', '.']); run(main, ['commit', '-qm', 'base']);
  run(main, ['worktree', 'add', '-q', '-b', 'feature', linked]);
  await writeFile(join(main, 'file.txt'), 'main changed\n'); await writeFile(join(linked, 'file.txt'), 'linked changed\n');
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000, git: { executable: git } });
  const request: ContextBuildRequest = { task: 'Collect worktree evidence', constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } }] },
    requiredSources: [], documents: [], patches: [], copyPreset: 'standard', storedPrompts: [],
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: 'packet' };
  const diff = gitValidator.Parse(gitValidator.Default({ op: 'diff', maxOutputBytes: 100000 })); assert(diff.op === 'diff');
  const options = { scope: 'all' as const, mode: 'standard' as const, snapshotID: 'attached',
    inlineMap: false, inlineMode: 'brief', inlineMaxLines: 120 };
  return { main, linked, output, run, runtime, request, diff, options };
}

test('published worktree replies retain attached/detached metadata and distinguish listed main roots from manifest roots', async () => {
  const proof: unknown[] = [];
  for (const separate of [false, true]) {
    const f = await fixture(separate);
    try {
      const workspace = await f.runtime.declare({ roots: [{ name: 'r', absolutePath: f.linked }], exclusions: [], outputRoot: f.output }, signal());
      const draft = await workspace.createDraft(f.request, signal());
      const published = await draft.publishGitSnapshot(f.diff, f.options, signal());
      assert(published.kind === 'single');
      const reply = published.projection.reply, worktree = reply.worktree; assert(worktree);
      assert((await draft.readGitArtifact(published.projection.primarySelectionAliases[0]!, signal())).text.includes('WORKTREE'));
      assert.equal(worktree.worktree_root, f.linked);
      assert.equal(worktree.main_worktree_root, f.main);
      assert.equal(worktree.worktree_branch, 'feature'); assert.equal(worktree.main_branch, 'main');
      assert.equal(worktree.worktree_head, f.run(f.linked, ['rev-parse', 'HEAD']).trim().slice(0, 7));
      assert.equal(worktree.main_head, f.run(f.main, ['rev-parse', 'HEAD']).trim().slice(0, 7));
      assert(reply.warning?.includes('This: feature@' + worktree.worktree_head));
      assert(reply.warning?.includes('worktree=')); assert(!reply.warning?.includes('repo_root='));
      const saved = manifest.Parse(JSON.parse(await readFile(join(f.output, '_git_data', published.snapshotDir, 'manifest.json'), 'utf8')));
      assert.equal(saved.mainWorktreeRoot, separate ? undefined : f.main);
      const operation = await workspace.openOperation(signal());
      try {
        const main = await operation.readGit({ ...f.diff, root: 'r', worktree: f.main });
        assert.equal(main.kind, 'git');
      } finally { await operation.close(); }
      f.run(f.linked, ['checkout', '-q', '--detach']);
      const detached = await draft.publishGitSnapshot(f.diff, { ...f.options, snapshotID: 'detached' }, signal());
      assert(detached.kind === 'single');
      assert((await draft.readGitArtifact(detached.projection.primarySelectionAliases[1]!, signal())).text.includes('diff --git'));
      assert.equal(detached.projection.reply.worktree?.worktree_branch, '');
      proof.push({ separateGitDirectory: separate, attached: reply, manifest: saved, detached: detached.projection.reply });
      await draft.close(); await workspace.close();
      const mainWorkspace = await f.runtime.declare({ roots: [{ name: 'r', absolutePath: f.main }], exclusions: [], outputRoot: f.output }, signal());
      const mainDraft = await mainWorkspace.createDraft(f.request, signal());
      const canonical = await mainDraft.publishGitSnapshot(f.diff, { ...f.options, snapshotID: 'canonical' }, signal());
      assert(canonical.kind === 'single');
      assert.equal(canonical.projection.reply.worktree, undefined); assert.equal(canonical.projection.reply.warning, undefined);
      await mainDraft.close(); await mainWorkspace.close();
    } finally { await f.runtime.close(); }
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/git-worktree-publication-proof.json', JSON.stringify(proof, null, 2) + '\n');
});

test('worktree metadata permits unavailable branch text and joins cancelled Git execution', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture(false), controller = new AbortController(), held: OwnedProcess[] = [];
    const spawn = f.runtime.supervisor.spawn.bind(f.runtime.supervisor);
    let entered!: () => void;
    const holding = new Promise<void>(resolve => { entered = resolve; });
    t.mock.method(f.runtime.supervisor, 'spawn', (spec: ProcessSpec) => {
      if (spec.executable === git && (spec.args.includes('symbolic-ref') || spec.args.includes('branch') || spec.args.includes('--abbrev-ref'))) {
        const child = spawn({ ...spec, executable: process.execPath, args: cancel
          ? [resolve('test/fixtures/held-git-read.mjs')] : ['-e', 'process.exitCode = 1'] });
        held.push(child);
        child.child.stderr.on('data', data => { if (data.toString().includes('SMIP_GIT_READ_HELD')) entered(); });
        return child;
      }
      return spawn(spec);
    });
    try {
      const workspace = await f.runtime.declare({ roots: [{ name: 'r', absolutePath: f.linked }], exclusions: [], outputRoot: f.output }, signal());
      const draft = await workspace.createDraft(f.request, signal());
      const pending = draft.publishGitSnapshot(f.diff, f.options, controller.signal);
      if (cancel) {
        await holding; controller.abort(); await assert.rejects(pending, /cancelled|aborted/i);
        assert.equal(held.length, 1);
      } else {
        const published = await pending;
        assert(published.kind === 'single');
        assert.equal(published.projection.reply.worktree?.worktree_branch, undefined);
        assert.equal(published.projection.reply.worktree?.main_branch, undefined);
      }
      await draft.close(); await workspace.close();
      await Promise.all(held.map(child => child.closed));
    } finally { await f.runtime.close(); }
  }
});
