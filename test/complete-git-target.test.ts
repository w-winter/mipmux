import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MipmuxRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { contextRequestValidator, manifestValidator } from '../src/contracts/context.js';

test('complete Git resolves an explicitly declared metadata directory and retains protected-path exclusions', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-complete-git-target-'));
  const metadata = join(base, 'metadata'), worktree = join(base, 'worktree'), output = join(base, 'output');
  for (const path of [metadata, worktree, output]) await mkdir(path);
  const git = (cwd: string, args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] });
  git(metadata, ['init', '--bare']);
  git(metadata, ['config', 'core.bare', 'false']); git(metadata, ['config', 'core.worktree', worktree]);
  await writeFile(join(worktree, '.git'), 'gitdir: ' + metadata + '\n');
  await writeFile(join(worktree, 'file.txt'), 'before\n');
  await writeFile(join(worktree, 'private.txt'), 'synthetic before\n');
  git(worktree, ['add', '--', 'file.txt', 'private.txt']);
  git(worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test: initialize complete Git fixture']);
  await writeFile(join(worktree, 'file.txt'), 'after\n');
  await writeFile(join(worktree, 'private.txt'), 'PROTECTED_BODY_MUST_NOT_APPEAR\n');
  const nativeExecutable = resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`);
  const settings = copyContext();
  settings.current = { fileTreeMode: 'None', codeMapUsage: 'none', gitInclusion: 'all' };
  settings.activeGitRoot = 'r';
  const runtime = new MipmuxRuntime({ copyContext: settings, cachePath: join(base, 'cache'), contextBudgetUnits: 200000,
    credentialPaths: [join(worktree, 'private.txt')], nativeExecutable, nativeEnvironment: {},
    terminationGraceMs: 100, git: { executable: '/usr/bin/git' } });
  const signal = () => new AbortController().signal;
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: metadata }], outputRoot: output,
      exclusions: [] }, signal());
    const request = contextRequestValidator.Parse({ task: 'Explain changes', constraints: '', purpose: 'investigation',
      enhancementMode: 'preserve', initialSelection: { codemapMode: 'manual', sources: [] }, requiredSources: [],
      documents: [], patches: [], duplicateUserInstructionsAtTop: false, budgetUnits: 200000,
      discoveryHints: [], outputName: 'packet', copyPreset: 'manual' });
    const draft = await workspace.createDraft(request, signal());
    const interim = await workspace.createDraft({ ...request, copyPreset: 'standard', outputName: 'standard-packet' }, signal());
    await interim.prompt({ op: 'export', path: 'complete.md', copy_preset: 'manual', maxOutputBytes: 100000 }, signal());
    assert.equal(interim.revision, 0); assert.equal(interim.request.copyPreset.raw.builtInKind, 'standard');
    const result = await draft.finalize(signal());
    assert(result.kind === 'ready');
    const context = await readFile(join(result.directory, 'context.md'), 'utf8');
    assert.equal(await readFile(join(output, 'complete.md'), 'utf8'), context);
    assert(context.includes('-before\n+after\n')); assert(!context.includes('PROTECTED_BODY_MUST_NOT_APPEAR'));
    await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, runtime, signal());
    const manifestPath = join(result.directory, 'manifest.json'), original = await readFile(manifestPath, 'utf8');
    const manifest = manifestValidator.Parse(JSON.parse(original));
    assert(manifest.automaticGit !== null);
    assert.equal(manifest.automaticGit.evidence.rootBinding?.kind, 'gitDirectory');
    manifest.automaticGit.evidence.rootBinding = { kind: 'worktree' };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyBundle(result.directory), /invalidClipboard|bundleIntegrityFailed/);
    await writeFile(manifestPath, original);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/complete-metadata-root.json', JSON.stringify({ directory: result.directory,
      scope: result.manifest.automaticGit?.evidence.scope, context }, null, 2) + '\n');
  } finally { await runtime.close(); }
});
