import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { ContextBuildRequest } from '../src/contracts/context.js';
import { gitValidator } from '../src/contracts/git.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import type { OwnedProcess, ProcessSpec } from '../src/runtime/process-supervisor.js';

const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'smip-git-batch-')), output = join(base, 'out'); await mkdir(output);
  const roots = [];
  for (const name of ['a', 'b', 'c', 'd']) {
    const path = join(base, name); await mkdir(path); await writeFile(join(path, 'file.txt'), 'base\n');
    const run = (args: string[]) => execFileSync(git, args, { cwd: path, encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    run(['init', '-q', '-b', 'main']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
    run(['add', '.']); run(['commit', '-qm', 'base']); await writeFile(join(path, 'file.txt'), 'changed ' + name + '\n');
    roots.push({ name, absolutePath: path });
  }
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000, git: { executable: git } };
  const request: ContextBuildRequest = { task: 'Collect repository evidence', constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: 'manual', sources: ['b', 'd', 'a', 'c'].map(root => ({ kind: 'full', source: { root, path: 'file.txt' } })) },
    requiredSources: [], documents: [], patches: [], copyPreset: 'standard', storedPrompts: [],
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: 'packet' };
  const diff = gitValidator.Parse(gitValidator.Default({ op: 'diff', maxOutputBytes: 1 })); assert(diff.op === 'diff');
  const publication = { scope: 'all' as const, mode: 'standard' as const, snapshotID: 'batch',
    inlineMap: false, inlineMode: 'brief', inlineMaxLines: 120 };
  return { base, output, roots, options, request, diff, publication };
}

test('implicit publication retains frozen repository order, selected skips and per-repository pathspecs', async () => {
  const f = await fixture(), runtime = new SmipRuntime(f.options);
  try {
    const workspace = await runtime.declare({ roots: f.roots, exclusions: [], outputRoot: f.output }, signal());
    const draft = await workspace.createDraft(f.request, signal());
    const all = await draft.publishGitSnapshot(f.diff, f.publication, signal()); assert.equal(all.kind, 'multiple');
    if (all.kind !== 'multiple') throw Error('Expected repository batch');
    assert.deepEqual(all.publications.map(item => item.checkout.root), ['a', 'b', 'c', 'd']);
    assert.equal(all.projection.reply.aggregate.repo_count, 4); assert.equal(all.projection.reply.aggregate.totals.files, 4);
    for (const item of all.publications) {
      const body = await readFile(join(f.output, '_git_data', item.snapshotDir, 'diff/all.patch'), 'utf8');
      assert(body.includes('+changed ' + item.checkout.root));
    }
    await draft.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'remove', source: { root: 'b', path: 'file.txt' } } }, signal());
    const selected = await draft.publishGitSnapshot(f.diff, { ...f.publication, scope: 'selected', snapshotID: 'selected' }, signal());
    if (selected.kind !== 'multiple') throw Error('Expected selected batch');
    assert.equal(selected.projection.reply.aggregate.repo_count, 4); assert.equal(selected.projection.reply.aggregate.totals.files, 3);
    const noSelection = selected.projection.reply.repos[1]; assert(noSelection && 'empty_reason' in noSelection);
    assert.equal(noSelection.empty_reason, 'No selected paths in this repo');
    assert.deepEqual(selected.publications.map(item => item.checkout.root), ['a', 'c', 'd']);
    const paths = await draft.publishGitSnapshot({ ...f.diff, paths: [join(f.base, 'a/file.txt')] },
      { ...f.publication, snapshotID: 'path-filtered' }, signal());
    if (paths.kind !== 'multiple') throw Error('Expected path-filtered batch');
    assert.equal(paths.publications.length, 1); assert.equal(paths.projection.reply.aggregate.totals.files, 1);
    const noPaths = paths.projection.reply.repos[1]; assert(noPaths && 'empty_reason' in noPaths);
    assert.equal(noPaths.empty_reason, 'No requested paths in this repo');
    const explicit = await draft.publishGitSnapshot({ ...f.diff, root: 'c' }, { ...f.publication, snapshotID: 'explicit' }, signal());
    assert.equal(explicit.kind, 'single');
    if (explicit.kind === 'single') assert.equal(explicit.checkout.root, 'c');
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/git-publication-batch-proof.json', JSON.stringify({ all, selected, paths, explicit }, null, 2) + '\n');
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});

test('a repository write failure retains sibling snapshots and projects a per-repository error', async () => {
  const f = await fixture();
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (operation.kind === 'beginGitSnapshot' && operation.repoKey.startsWith('b-')) return Promise.reject(new NativeFailure('nativeIOFailed', 28));
          return super.request(operation, requestSignal);
        }
      }
      return new Bridge({ executable: f.options.nativeExecutable, env: {}, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime(f.options);
  try {
    const workspace = await runtime.declare({ roots: f.roots, exclusions: [], outputRoot: f.output }, signal());
    const draft = await workspace.createDraft(f.request, signal());
    const result = await draft.publishGitSnapshot(f.diff, f.publication, signal());
    if (result.kind !== 'multiple') throw Error('Expected partial batch');
    assert.deepEqual(result.publications.map(item => item.checkout.root), ['a', 'c', 'd']);
    const failed = result.projection.reply.repos[1]; assert(failed && 'error' in failed); assert.equal(failed.error, 'nativeIOFailed');
    assert.equal(result.projection.reply.aggregate.repo_count, 4); assert.equal(result.projection.reply.aggregate.totals.files, 3);
    assert.equal((await readdir(join(f.output, '_git_data/repos'))).length, 3);
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});

test('batch cancellation joins admitted Git work and cannot publish an aggregate reply', async t => {
  const f = await fixture(), runtime = new SmipRuntime(f.options), controller = new AbortController(), held: OwnedProcess[] = [];
  const spawn = runtime.supervisor.spawn.bind(runtime.supervisor);
  let entered!: () => void; const holding = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(runtime.supervisor, 'spawn', (spec: ProcessSpec) => {
    if (spec.executable === git && spec.args.includes('--porcelain')) {
      const child = spawn({ ...spec, executable: process.execPath, args: [resolve('test/fixtures/held-git-read.mjs')] }); held.push(child);
      child.child.stderr.on('data', data => { if (data.toString().includes('SMIP_GIT_READ_HELD')) entered(); }); return child;
    }
    return spawn(spec);
  });
  try {
    const workspace = await runtime.declare({ roots: f.roots, exclusions: [], outputRoot: f.output }, signal());
    const draft = await workspace.createDraft(f.request, signal());
    const pending = draft.publishGitSnapshot(f.diff, f.publication, controller.signal);
    await holding; controller.abort(); await assert.rejects(pending, /cancelled|aborted/i);
    await Promise.all(held.map(child => child.closed)); assert(held.length > 0);
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});
