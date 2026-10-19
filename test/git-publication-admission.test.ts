import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { ContextBuildRequest, SourceSelection } from '../src/contracts/context.js';
import { gitValidator } from '../src/contracts/git.js';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';

const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;
const full = (root: string, path = 'file.txt'): SourceSelection => ({ kind: 'full', source: { root, path } });

test('publication capture admits current checkout subsets but refuses changed, empty and deferred ownership', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-publication-fence-')), out = join(base, 'out'); await mkdir(out);
  const roots = [];
  for (const name of ['a', 'b', 'c']) {
    const path = join(base, name); await mkdir(path); await writeFile(join(path, 'file.txt'), 'base\n');
    await writeFile(join(path, 'other.txt'), 'support\n');
    const run = (args: string[]) => execFileSync(git, args, { cwd: path, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: base,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
    run(['add', '.']); run(['commit', '-qm', 'base']); await writeFile(join(path, 'file.txt'), 'changed ' + name + '\n');
    roots.push({ name, absolutePath: path });
  }
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000, git: { executable: git } });
  const request = (sources: SourceSelection[], outputName: string): ContextBuildRequest => ({ task: 'Collect evidence', constraints: '',
    enhancementMode: 'preserve', purpose: 'review', initialSelection: { codemapMode: 'manual', sources }, requiredSources: [], documents: [], patches: [],
    copyPreset: 'standard', storedPrompts: [], duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName });
  const input = gitValidator.Parse(gitValidator.Default({ op: 'diff', maxOutputBytes: 100000 })); assert(input.op === 'diff');
  try {
    const workspace = await runtime.declare({ roots, exclusions: [], outputRoot: out }, signal());
    const draft = await workspace.createDraft(request([full('a'), full('b')], 'subset'), signal());
    try {
      await draft.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'remove', source: { root: 'b', path: 'file.txt' } } }, signal());
      const captured = await draft.captureGitPublication(input, true, 'all', signal());
      assert(captured.content.diffText?.includes('changed a'));
      await assert.rejects(draft.captureGitPublication({ ...input, root: 'c' }, true, 'all', signal()), /gitPublicationTargetDenied/);
      const cancelled = new AbortController(); cancelled.abort();
      await assert.rejects(draft.captureGitPublication(input, true, 'all', cancelled.signal), /cancelled|aborted/i);
      await draft.update({ expectedRevision: 1, maxOutputBytes: 100000, mutation: { kind: 'upsert', selection: full('a', 'other.txt') } }, signal());
      assert((await draft.captureGitPublication(input, true, 'all', signal())).content.diffText?.includes('changed a'));
      await draft.update({ expectedRevision: 2, maxOutputBytes: 100000, mutation: { kind: 'upsert', selection: full('c') } }, signal());
      await assert.rejects(draft.captureGitPublication(input, true, 'all', signal()), /gitSelectionOwnershipChanged/);
    } finally { await draft.close(); }
    const otherCheckout = await workspace.createDraft(request([full('a'), full('b')], 'empty-in-primary'), signal());
    try {
      await otherCheckout.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'remove', source: { root: 'a', path: 'file.txt' } } }, signal());
      const captured = await otherCheckout.captureGitPublication(input, true, 'selected', signal());
      assert.equal(captured.checkout.root, 'a'); assert.equal(captured.content.scope, 'selected');
      assert.equal(captured.content.requestedPaths, null); assert.equal(captured.content.summary.files, 0);
      assert.equal(captured.content.diffText, null); assert.equal(captured.content.perFile, null);
    } finally { await otherCheckout.close(); }
    const empty = await workspace.createDraft(request([full('a')], 'empty'), signal());
    try {
      await empty.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'clearSources' } }, signal());
      await assert.rejects(empty.captureGitPublication(input, true, 'all', signal()), /gitSelectionOwnershipChanged/);
    } finally { await empty.close(); }
    const deferred = await workspace.createDraft(request([], 'deferred'), signal());
    try {
      await deferred.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'upsert', selection: full('a') } }, signal());
      await assert.rejects(deferred.captureGitPublication(input, true, 'all', signal()), /gitTargetRequired/);
    } finally { await deferred.close(); }
    const stale = await workspace.createDraft(request([full('a'), full('b')], 'stale'), signal());
    try {
      await stale.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'remove', source: { root: 'b', path: 'file.txt' } } }, signal());
      await rename(join(base, 'b/.git'), join(base, 'removed-git'));
      await assert.rejects(stale.captureGitPublication(input, true, 'all', signal()), /gitRepositoryChanged/);
    } finally { await rename(join(base, 'removed-git'), join(base, 'b/.git')); await stale.close(); }
    await workspace.close();
    await writeFile('test-output/git-publication-admission-proof.json', JSON.stringify({ checkoutSubsetAccepted: true, newFilesInFrozenCheckoutAccepted: true,
      changedOwnershipRefused: true, emptyRefused: true, deferredRefused: true, removedOriginalCheckoutRefused: true }, null, 2) + '\n');
  } finally { await runtime.close(); }
});
