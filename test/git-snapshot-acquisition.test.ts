import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { gitValidator } from '../src/contracts/git.js';
import { NativeGitSnapshotInput } from '../src/contracts/git-snapshot.js';
import { BridgeClient, type NativeReply } from '../src/native/bridge-client.js';
import { ProcessSupervisor, type OwnedProcess, type ProcessSpec } from '../src/runtime/process-supervisor.js';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';

const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;
const nativeExecutable = resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`);
const fixtures = Compile(Type.Object({ mtime: Type.Number(), files: Type.Array(Type.Object({ path: Type.String(), text: Type.String() })),
  cases: Type.Array(Type.Object({ name: Type.String(), compare: Type.String(), headSHA: Type.String(), baseRefSHA: Type.String(), status: Type.String(),
    expected: Type.Object({ headSHA: Type.String(), baseRef: Type.String(), statusHash: Type.String() }) })) }));
const manifest = Compile(Type.Pick(NativeGitSnapshotInput, ['fingerprint', 'summary']));

test('native fingerprints match original status, rename, missing-file and metadata hashing', async () => {
  const reference = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-fingerprint/cases.json', 'utf8')));
  const base = await mkdtemp(join(tmpdir(), 'smip-git-fingerprint-'));
  for (const file of reference.files) {
    await writeFile(join(base, file.path), file.text); await utimes(join(base, file.path), reference.mtime, reference.mtime);
  }
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ supervisor, executable: nativeExecutable, env: {} });
  const proof: unknown[] = [];
  try {
    const opened = await bridge.request({ kind: 'openRoots', roots: [{ name: 'r', absolutePath: base, access: 'source', expected: null }] }, signal());
    const root = opened.result.roots[0]; assert(root);
    for (const entry of reference.cases) {
      const reply: NativeReply<'fingerprintGitDiff'> = await bridge.request({ kind: 'fingerprintGitDiff', root: root.handle, compare: entry.compare,
        headSHA: entry.headSHA, baseRefSHA: entry.baseRefSHA, status: entry.status }, signal());
      const { generatedAt, ...value } = reply.result.fingerprint;
      assert.deepEqual(value, entry.expected, entry.name); assert(Number.isFinite(Date.parse(generatedAt)));
      proof.push({ name: entry.name, value });
    }
    await writeFile('test-output/git-fingerprint-proof.json', JSON.stringify(proof, null, 2) + '\n');
  } finally { await bridge.close(); await supervisor.close(); }
});

async function fixture() {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-snapshot-acquire-')), repo = join(base, 'repo'), out = join(base, 'out');
  await mkdir(repo); await mkdir(out);
  const run = (args: string[]) => execFileSync(git, args, { cwd: repo, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: base,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(repo, 'tracked.txt'), 'base\n'); await writeFile(join(repo, 'denied.txt'), 'protected base\n');
  run(['add', '.']); run(['commit', '-qm', 'base']); const head = run(['rev-parse', 'HEAD']).trim();
  await writeFile(join(repo, 'tracked.txt'), 'staged\n'); run(['add', '--', 'tracked.txt']);
  await writeFile(join(repo, 'tracked.txt'), 'working\n'); await writeFile(join(repo, 'new.txt'), 'untracked\n');
  await writeFile(join(repo, 'denied.txt'), 'PROTECTED_BODY\n');
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'), nativeExecutable, nativeEnvironment: {},
    credentialPaths: [join(repo, 'denied.txt')], git: { executable: git }, terminationGraceMs: 100, contextBudgetUnits: 200000 });
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: repo }], exclusions: [], outputRoot: out }, signal());
  const request = (compare: string, paths: string[] = []) => {
    const value = gitValidator.Parse(gitValidator.Default({ op: 'diff', root: 'r', compare, paths, detail: 'summary', maxOutputBytes: 1 }));
    assert.equal(value.op, 'diff'); return value;
  };
  return { base, repo, run, head, runtime, workspace, request };
}

test('live acquisition retains complete authorized bodies before summary projection and output caps', async () => {
  const f = await fixture(), operation = await f.workspace.openOperation(signal()), proof: unknown[] = [];
  const serializer = f.runtime.makeBridge();
  const index = await readFile(join(f.repo, '.git/index'));
  try {
    for (const [compare, added, removed, untracked] of [
      ['uncommitted', 'working', 'base', true], ['staged', 'staged', 'base', false], ['unstaged', 'working', 'staged', true],
    ] as const) {
      const capture = await operation.captureGitDiff(f.request(compare), true);
      assert.equal(capture.content.fingerprint.headSHA, f.head);
      assert.equal(capture.content.scope, 'all'); assert.equal(capture.content.requestedPaths, null);
      const patch = capture.content.perFile?.['tracked.txt']; assert(patch);
      assert(patch.includes('+' + added)); assert(patch.includes('-' + removed));
      assert.equal(capture.content.changedFiles.some(file => file.path === 'new.txt'), untracked);
      assert(!capture.content.changedFiles.some(file => file.path === 'denied.txt'));
      assert(!JSON.stringify(capture.content).includes('PROTECTED_BODY'));
      assert.equal(capture.exclusions.includes('denied.txt'), compare !== 'staged');
      assert(capture.content.diffText?.includes(patch));
      assert.deepEqual(capture.content.summary, { files: untracked ? 2 : 1, insertions: untracked ? 2 : 1, deletions: 1 });
      const serialized = await serializer.request({ kind: 'serializeGitSnapshot', input: { ...capture.content,
        snapshotID: compare, repoKey: 'fixture', mode: 'standard', compare: capture.commands.display, compareInput: compare,
        contextLines: 3, detectRenames: false, commitGraph: '', repoRoot: f.repo, tabID: null, worktree: null } }, signal());
      const patchFile = serialized.result.files.find(file => file.path === 'diff/all.patch'); assert(patchFile);
      assert.equal(Buffer.from(patchFile.bytes, 'base64').toString(), capture.content.diffText);
      const manifestFile = serialized.result.files.find(file => file.path === 'manifest.json'); assert(manifestFile);
      const saved = manifest.Parse(JSON.parse(Buffer.from(manifestFile.bytes, 'base64').toString()));
      assert.deepEqual(saved.fingerprint, capture.content.fingerprint); assert.deepEqual(saved.summary, capture.content.summary);
      proof.push({ capture, serialized });
    }
    const selected = await operation.captureGitDiff(f.request('uncommitted', ['tracked.txt']), true);
    assert.equal(selected.content.scope, 'selected'); assert.deepEqual(selected.content.requestedPaths, ['tracked.txt']);
    const quick = await operation.captureGitDiff(f.request('uncommitted'), false);
    assert.equal(quick.content.diffText, null); assert.equal(quick.content.perFile, null); assert.equal(quick.content.summary.files, 2);
    const empty = await operation.captureGitDiff(f.request('staged', ['absent.txt']), true);
    assert.equal(empty.content.diffText, null); assert.equal(empty.content.perFile, null); assert.equal(empty.content.summary.files, 0);
    const status = f.run(['status', '--porcelain', '-z', '--untracked-files=all']);
    const unstaged = await operation.captureGitDiff(f.request('unstaged'), false);
    assert.equal(unstaged.content.fingerprint.baseRef, 'INDEX');
    assert.equal(unstaged.content.fingerprint.statusHash, 'index:' + createHash('sha256').update(status).digest('hex'));
    const revision = await operation.captureGitDiff(f.request('HEAD'), false);
    assert.equal(revision.content.fingerprint.baseRef, 'HEAD'); assert.equal(revision.content.fingerprint.statusHash, 'revspec:HEAD');
    await assert.rejects(operation.captureGitDiff(f.request('--output=' + join(f.base, 'injected')), true), /invalidRequest/);
    assert.deepEqual(await readFile(join(f.repo, '.git/index')), index);
    await writeFile('test-output/git-snapshot-acquisition-proof.json', JSON.stringify({ proof, selected, quick, empty, indexUnchanged: true }, null, 2) + '\n');
  } finally { await serializer.close(); await operation.close(); await f.workspace.close(); await f.runtime.close(); }
});

test('cancellation during snapshot fingerprinting joins Git work before operation settlement', async t => {
  const f = await fixture(), controller = new AbortController(), operation = await f.workspace.openOperation(controller.signal);
  const spawn = f.runtime.supervisor.spawn.bind(f.runtime.supervisor), held: OwnedProcess[] = [];
  let entered!: () => void; const holding = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(f.runtime.supervisor, 'spawn', (spec: ProcessSpec) => {
    if (spec.executable === git && spec.args.includes('--porcelain')) {
      const child = spawn({ ...spec, executable: process.execPath, args: [resolve('test/fixtures/held-git-read.mjs')] }); held.push(child);
      child.child.stderr.on('data', data => { if (data.toString().includes('SMIP_GIT_READ_HELD')) entered(); }); return child;
    }
    return spawn(spec);
  });
  try {
    const pending = operation.captureGitDiff(f.request('uncommitted'), true);
    await holding; controller.abort(); await assert.rejects(pending, /cancelled|aborted/i);
    await operation.close(); const joined = await Promise.all(held.map(child => child.closed)); assert.equal(joined.length, 1);
    await writeFile('test-output/git-snapshot-acquisition-cancel-proof.json', JSON.stringify({ joined }, null, 2) + '\n');
  } finally { await operation.close(); await f.workspace.close(); await f.runtime.close(); }
});
