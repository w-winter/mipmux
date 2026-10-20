import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import type { LocalComparison } from '../src/contracts/patches.js';
import type { Static } from 'typebox';

test('worktree, staged and commit patches for a declared subroot retain owning-checkout paths and exclude sibling evidence', async () => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'smip-git-subroot-'));
  const repo = join(directory, 'repo'), root = join(repo, 'src'), out = join(directory, 'out');
  await mkdir(repo); await mkdir(root); await mkdir(join(repo, 'src-copy')); await mkdir(out);
  const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
  const run = (args: string[], cwd = repo) => execFileSync(git, args, { cwd, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'kept.txt'), 'before\n'); await writeFile(join(root, 'deleted.txt'), 'deleted\n');
  await writeFile(join(repo, 'outside.txt'), 'OUTSIDE BEFORE\n'); await writeFile(join(repo, 'src-copy/sibling.txt'), 'SIBLING BEFORE\n');
  run(['add', '--all']); run(['commit', '-m', 'baseline']); const base = run(['rev-parse', 'HEAD']).trim();
  await writeFile(join(root, 'kept.txt'), 'after\n'); await unlink(join(root, 'deleted.txt'));
  await writeFile(join(repo, 'outside.txt'), 'OUTSIDE AFTER\n'); await writeFile(join(repo, 'src-copy/sibling.txt'), 'SIBLING AFTER\n');
  run(['add', '-u']); run(['commit', '-m', 'target']); const target = run(['rev-parse', 'HEAD']).trim();
  await writeFile(join(root, 'added.txt'), 'added\n'); await writeFile(join(repo, 'outside-untracked.txt'), 'OUTSIDE UNTRACKED\n');
  const index = await readFile(join(repo, '.git/index'));
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(directory, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    git: { executable: git }, nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = new AbortController().signal;
  const comparisons: Static<typeof LocalComparison>[] = [
    { kind: 'worktree', base: { kind: 'commit', ref: base }, includeUntracked: true },
    { kind: 'staged', base: { kind: 'commit', ref: base } },
    { kind: 'commits', base: { kind: 'commit', ref: base }, target },
  ];
  const proof = [];
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal);
    for (const comparison of comparisons) {
      const draft = await workspace.createDraft({ initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard',
        task: 'Inspect the declared source root.', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
        requiredSources: [{ kind: 'full', source: { root: 'r', path: 'kept.txt' } }], documents: [],
        patches: [{ kind: 'localPatch', id: 'changes', root: 'r', comparison, scope: { kind: 'all' } }],
        budgetUnits: 100000, discoveryHints: [], outputName: comparison.kind }, signal);
      const result = await draft.finalize(signal); assert(result.kind === 'ready');
      const patch = result.manifest.materials.find(record => record.kind === 'patch'); assert(patch?.kind === 'patch');
      assert(patch.receipt.repository);
      assert.equal(patch.receipt.repository.worktree.canonicalPath, await realpath(repo));
      assert.deepEqual(patch.receipt.coverage, comparison.kind === 'worktree' ? ['added.txt', 'deleted.txt', 'kept.txt'] : ['deleted.txt', 'kept.txt']);
      assert(patch.receipt.targets.every(target => !target.path.startsWith('src/') && target.path !== 'outside.txt'));
      const context = await readFile(join(result.directory, 'context.md'));
      const span = patch.spans[0]!; const text = context.subarray(span.offset, span.offset + span.length);
      assert(text.includes(Buffer.from('a/src/kept.txt')));
      assert(!text.includes(Buffer.from('outside.txt'))); assert(!text.includes(Buffer.from('src-copy')));
      const patchFile = join(directory, comparison.kind + '.patch'); await writeFile(patchFile, text);
      const apply = join(directory, 'apply-' + comparison.kind); await mkdir(apply);
      const archive = join(directory, comparison.kind + '.tar'); await writeFile(archive, execFileSync(git, ['archive', base], { cwd: repo }));
      execFileSync('tar', ['-xf', archive, '-C', apply]); run(['init'], apply); run(['apply', '--check', patchFile], apply); run(['apply', patchFile], apply);
      assert.equal(await readFile(join(apply, 'src/kept.txt'), 'utf8'), 'after\n');
      assert.equal(await readFile(join(apply, 'outside.txt'), 'utf8'), 'OUTSIDE BEFORE\n');
      if (comparison.kind === 'worktree') assert.equal(await readFile(join(apply, 'src/added.txt'), 'utf8'), 'added\n');
      await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, runtime, signal);
      proof.push({ comparison: comparison.kind, directory: result.directory, receipt: patch.receipt, patch: patchFile, applied: apply });
      await draft.close();
    }
    assert.deepEqual(await readFile(join(repo, '.git/index')), index);
    await writeFile('test-output/git-subroot-proof.json', JSON.stringify(proof, null, 2) + '\n');
    await workspace.close();
  } finally { await runtime.close(); }
});
