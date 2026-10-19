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

test('production publication admits current checkout subsets but refuses changed, empty and deferred ownership', async () => {
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
  const input = gitValidator.Parse(gitValidator.Default({ op: 'diff', root: 'a', maxOutputBytes: 100000 })); assert(input.op === 'diff');
  const options = { mode: 'standard' as const, scope: 'all' as const, snapshotID: null,
    inlineMap: true, inlineMode: 'brief', inlineMaxLines: 120 };
  try {
    const workspace = await runtime.declare({ roots, exclusions: [], outputRoot: out }, signal());
    const draft = await workspace.createDraft(request([full('a'), full('b')], 'subset'), signal());
    try {
      await draft.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'remove', source: { root: 'b', path: 'file.txt' } } }, signal());
      const captured = await draft.publishGitSnapshot(input, options, signal()); assert(captured.kind === 'single');
      assert(captured.files.some(file => file.path === 'diff/all.patch' && Buffer.from(file.bytes, 'base64').toString().includes('changed a')));
      await assert.rejects(draft.publishGitSnapshot({ ...input, root: 'c' }, options, signal()), /gitPublicationTargetDenied/);
      const cancelled = new AbortController(); cancelled.abort();
      await assert.rejects(draft.publishGitSnapshot(input, options, cancelled.signal), /cancelled|aborted/i);
      await draft.update({ expectedRevision: 1, maxOutputBytes: 100000, mutation: { kind: 'upsert', selection: full('a', 'other.txt') } }, signal());
      const updated = await draft.publishGitSnapshot(input, options, signal()); assert(updated.kind === 'single');
      assert(updated.files.some(file => file.path === 'diff/all.patch' && Buffer.from(file.bytes, 'base64').toString().includes('changed a')));
      await draft.update({ expectedRevision: 2, maxOutputBytes: 100000, mutation: { kind: 'upsert', selection: full('c') } }, signal());
      await assert.rejects(draft.publishGitSnapshot(input, options, signal()), /gitSelectionOwnershipChanged/);
    } finally { await draft.close(); }
    const otherCheckout = await workspace.createDraft(request([full('a'), full('b')], 'empty-in-primary'), signal());
    try {
      await otherCheckout.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'remove', source: { root: 'a', path: 'file.txt' } } }, signal());
      const captured = await otherCheckout.publishGitSnapshot(input, { ...options, scope: 'selected' }, signal());
      assert(captured.kind === 'single'); assert.equal(captured.checkout.root, 'a');
      assert.equal(captured.projection.reply.inputs.scope, 'selected');
      assert.equal(captured.projection.reply.summary.files, 0);
      assert(!captured.files.some(file => file.path.startsWith('diff/')));
    } finally { await otherCheckout.close(); }
    const empty = await workspace.createDraft(request([full('a')], 'empty'), signal());
    try {
      await empty.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'clearSources' } }, signal());
      await assert.rejects(empty.publishGitSnapshot(input, options, signal()), /gitSelectionOwnershipChanged/);
    } finally { await empty.close(); }
    const deferred = await workspace.createDraft(request([], 'deferred'), signal());
    try {
      await deferred.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'upsert', selection: full('a') } }, signal());
      await assert.rejects(deferred.publishGitSnapshot(input, options, signal()), /gitTargetRequired/);
    } finally { await deferred.close(); }
    const stale = await workspace.createDraft(request([full('a'), full('b')], 'stale'), signal());
    try {
      await stale.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'remove', source: { root: 'b', path: 'file.txt' } } }, signal());
      await rename(join(base, 'b/.git'), join(base, 'removed-git'));
      await assert.rejects(stale.publishGitSnapshot(input, options, signal()), /gitRepositoryChanged/);
    } finally { await rename(join(base, 'removed-git'), join(base, 'b/.git')); await stale.close(); }
    await workspace.close();
    await writeFile('test-output/git-publication-admission-proof.json', JSON.stringify({ checkoutSubsetAccepted: true, newFilesInFrozenCheckoutAccepted: true,
      changedOwnershipRefused: true, emptyRefused: true, deferredRefused: true, removedOriginalCheckoutRefused: true }, null, 2) + '\n');
  } finally { await runtime.close(); }
});
