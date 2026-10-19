import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle, type ContextBuildRequest } from '../src/index.js';
import { gitValidator } from '../src/contracts/git.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';

const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;

test('Review and implicit target election honor available Jujutsu while retaining nearer and independent Git checkouts', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'smip-selected-vcs-')));
  for (const path of ['colocated', 'colocated/nested', 'healthy', 'standalone', 'bin', 'out']) await mkdir(join(base, path));
  await writeFile(join(base, 'bin/jj'), '#!/bin/sh\nexit 99\n'); await chmod(join(base, 'bin/jj'), 0o755);
  const run = (root: string, args: string[]) => execFileSync(git, args, { cwd: join(base, root), encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  for (const root of ['colocated', 'colocated/nested', 'healthy']) {
    run(root, ['init', '-q']); run(root, ['config', 'user.name', 'Fixture']); run(root, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(base, root, 'file.txt'), 'base\n'); run(root, ['add', 'file.txt']); run(root, ['commit', '-qm', 'base']);
    await writeFile(join(base, root, 'file.txt'), root + ' changed\n');
  }
  for (const root of ['colocated', 'standalone']) await mkdir(join(base, root, '.jj'));
  await writeFile(join(base, 'standalone/file.txt'), 'standalone evidence\n');
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: { PATH: join(base, 'bin') }, terminationGraceMs: 100, git: { executable: git } });
  const request: ContextBuildRequest = { task: 'Inspect selected VCS ownership', constraints: '', purpose: 'review', enhancementMode: 'preserve',
    initialSelection: { codemapMode: 'manual', sources: ['colocated', 'healthy', 'standalone'].map(root => ({ kind: 'full', source: { root, path: 'file.txt' } })) },
    requiredSources: [], documents: [], patches: [], storedPrompts: [], duplicateUserInstructionsAtTop: false,
    copyPreset: 'codeReview', budgetUnits: 100000, discoveryHints: [], outputName: 'mixed' };
  try {
    const workspace = await runtime.declare({ roots: ['colocated', 'healthy', 'standalone'].map(name => ({ name, absolutePath: join(base, name) })),
      exclusions: [], outputRoot: join(base, 'out') }, signal());
    const mixed = await workspace.createDraft(request, signal());
    const diff = gitValidator.Parse(gitValidator.Default({ op: 'diff', detail: 'full', maxOutputBytes: 100000 })); assert(diff.op === 'diff');
    const colocated = await workspace.createDraft({ ...request, outputName: 'colocated', initialSelection: { codemapMode: 'manual',
      sources: [{ kind: 'full', source: { root: 'colocated', path: 'file.txt' } }] } }, signal());
    await assert.rejects(colocated.readScopedGit(diff, signal(), value => value), /gitTargetRequired/);
    await assert.rejects(mixed.readScopedGit(diff, signal(), value => value), /gitTargetRequired/);
    const ready = await mixed.finalize(signal()); assert.equal(ready.kind, 'ready');
    if (ready.kind !== 'ready') throw new Error('Review did not publish');
    const automatic = ready.manifest.automaticGit; assert(automatic);
    assert.equal(automatic.evidence.completeness, 'partial');
    assert.deepEqual(automatic.evidence.pathIssues.map(issue => ({ kind: issue.kind, path: issue.displayPath,
      backend: issue.kind === 'unsupportedBackend' ? issue.backend : null })), [
      { kind: 'unsupportedBackend', path: 'colocated/file.txt', backend: 'jujutsu' },
      { kind: 'unsupportedBackend', path: 'standalone/file.txt', backend: 'jujutsu' },
    ]);
    assert.equal(automatic.evidence.outcomes.length, 1);
    assert.equal(automatic.evidence.outcomes[0]!.checkout.identity.root, 'healthy');
    const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
    assert(context.includes('+healthy changed\n')); assert(!context.includes('+colocated changed\n'));
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, runtime, signal());
    const nested = await workspace.createDraft({ ...request, outputName: 'nested', initialSelection: { codemapMode: 'manual',
      sources: [{ kind: 'full', source: { root: 'colocated', path: 'nested/file.txt' } }] } }, signal());
    const implicit = await nested.readScopedGit(diff, signal(), value => value);
    assert(JSON.stringify(implicit).includes('colocated/nested changed'));
    const nestedReady = await nested.finalize(signal()); assert.equal(nestedReady.kind, 'ready');
    if (nestedReady.kind === 'ready') {
      assert.equal(nestedReady.manifest.automaticGit?.evidence.completeness, 'complete');
      assert.deepEqual(nestedReady.manifest.automaticGit?.evidence.pathIssues, []);
      await verifyBundle(nestedReady.directory);
    }
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/selected-path-vcs-proof.json', JSON.stringify({ ready, implicit, nestedReady }, null, 2) + '\n');
  } finally { await runtime.close(); }
});

test('VCS ownership retains successful path and root entries until runtime disposal, but never caches absence', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'smip-vcs-cache-')));
  for (const path of ['repo', 'plain', 'bin', 'out']) await mkdir(join(base, path));
  await writeFile(join(base, 'bin/jj'), '#!/bin/sh\nexit 99\n'); await chmod(join(base, 'bin/jj'), 0o755);
  const run = (root: string, args: string[]) => execFileSync(git, args, { cwd: join(base, root), encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run('repo', ['init', '-q']); run('repo', ['config', 'user.name', 'Fixture']); run('repo', ['config', 'user.email', 'fixture@example.invalid']);
  for (const path of ['a.txt', 'b.txt']) await writeFile(join(base, 'repo', path), 'base\n');
  run('repo', ['add', '.']); run('repo', ['commit', '-qm', 'base']);
  await writeFile(join(base, 'repo/a.txt'), 'changed\n'); await writeFile(join(base, 'plain/a.txt'), 'plain\n');
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: { PATH: join(base, 'bin') }, terminationGraceMs: 100, git: { executable: git } };
  const spec = { roots: ['repo', 'plain'].map(name => ({ name, absolutePath: join(base, name) })), exclusions: [], outputRoot: join(base, 'out') };
  const request = (root: string, path: string): ContextBuildRequest => ({ task: 'Inspect ownership caching', constraints: '', purpose: 'planning',
    enhancementMode: 'preserve', initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root, path } }] },
    requiredSources: [], documents: [], patches: [], storedPrompts: [], duplicateUserInstructionsAtTop: false,
    copyPreset: 'standard', budgetUnits: 100000, discoveryHints: [], outputName: 'cached' });
  const diff = gitValidator.Parse(gitValidator.Default({ op: 'diff', detail: 'full', maxOutputBytes: 100000 })); assert(diff.op === 'diff');
  const runtime = new SmipRuntime(options);
  try {
    const workspace = await runtime.declare(spec, signal());
    const first = await workspace.createDraft(request('repo', 'a.txt'), signal());
    await mkdir(join(base, 'repo/.jj'));
    assert(JSON.stringify(await first.readScopedGit(diff, signal(), value => value)).includes('+changed'));
    const cachedPath = await workspace.createDraft(request('repo', 'a.txt'), signal());
    await cachedPath.readScopedGit(diff, signal(), value => value);
    const newPath = await workspace.createDraft(request('repo', 'b.txt'), signal());
    await assert.rejects(newPath.readScopedGit(diff, signal(), value => value), /gitTargetRequired/);
    await assert.rejects(first.readScopedGit(diff, signal(), value => value), /gitRepositoryChanged/);
    await rename(join(base, 'repo/.jj'), join(base, 'retired-jj'));
    const stillCached = await workspace.createDraft(request('repo', 'b.txt'), signal());
    await assert.rejects(stillCached.readScopedGit(diff, signal(), value => value), /gitTargetRequired/);
    const absent = await workspace.createDraft(request('plain', 'a.txt'), signal());
    await assert.rejects(absent.readScopedGit(diff, signal(), value => value), /gitTargetRequired/);
    run('plain', ['init', '-q']);
    const operation = await workspace.openOperation(signal());
    try {
      assert.equal((await operation.electGitTarget([join(base, 'plain/a.txt')])).state, 'available');
    } finally { await operation.close(); }
  } finally { await runtime.close(); }
  const restarted = new SmipRuntime(options);
  try {
    const workspace = await restarted.declare(spec, signal());
    const draft = await workspace.createDraft(request('repo', 'b.txt'), signal());
    await draft.readScopedGit(diff, signal(), value => value);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/vcs-cache-lifecycle.json', JSON.stringify({ runtimeScoped: true, positivePathCached: true,
      rootBackendRevalidated: true, absenceNotCached: true, restartResolvesFresh: true }) + '\n');
  } finally { await restarted.close(); }
});

test('cancelling a VCS observer leaves the shared resolver available to later operations', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'smip-vcs-observer-')));
  await mkdir(join(base, 'root')); await mkdir(join(base, 'out'));
  execFileSync(git, ['init', '-q'], { cwd: join(base, 'root') });
  await writeFile(join(base, 'root/file.txt'), 'content\n');
  const barrier = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(complete => { resolve = complete; });
    return { promise, resolve };
  };
  const entered = barrier(), gate = barrier();
  let gated = false;
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, terminationGraceMs: 100, git: { executable: git } };
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (operation.kind === 'electGitTarget' && !gated) {
            gated = true; entered.resolve(); await gate.promise;
          }
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: options.nativeExecutable, env: options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime(options);
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(base, 'root') }],
      exclusions: [], outputRoot: join(base, 'out') }, signal());
    const controller = new AbortController(), first = await workspace.openOperation(controller.signal);
    const pending = first.electGitTarget([join(base, 'root/file.txt')]), refused = assert.rejects(pending, /cancelled/);
    await entered.promise; controller.abort(); gate.resolve(); await refused; await first.close();
    const later = await workspace.openOperation(signal());
    try { assert.equal((await later.electGitTarget([join(base, 'root/file.txt')])).state, 'available'); }
    finally { await later.close(); }
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/vcs-cancel-observer.json', JSON.stringify({ cancelledObserver: true, nextOperationAvailable: true }) + '\n');
  } finally { gate.resolve(); await runtime.close(); }
});
