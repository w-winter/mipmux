import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { BridgeClient, type NativeReply } from '../src/native/bridge-client.js';
import { ProcessSupervisor, type OwnedProcess, type ProcessSpec } from '../src/runtime/process-supervisor.js';

const signal = () => new AbortController().signal;
const executable = resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`);
const currentCases = Compile(Type.Array(Type.Object({ name: Type.String(), kind: Type.Enum(['file', 'symlink', 'absoluteSymlink', 'missing']),
  target: Type.String(), exists: Type.Boolean(), expected: Type.Union([Type.String(), Type.Null()]) })));

test('snapshot naming and CURRENT are repo-scoped, replace named bodies and read both source pointer forms', async () => {
  await mkdir('test-output', { recursive: true });
  const output = await mkdtemp(join(tmpdir(), 'smip-current-')), outside = await mkdtemp(join(tmpdir(), 'smip-current-outside-'));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 }), bridge = new BridgeClient({ supervisor, executable, env: {} });
  const proof: unknown[] = [];
  try {
    const opened = await bridge.request({ kind: 'openRoots', roots: [{ name: 'out', absolutePath: output, access: 'output', expected: null }] }, signal());
    const root = opened.result.roots[0]; assert(root);
    const current = (repoKey: string) => bridge.request({ kind: 'readGitSnapshotCurrent', root: root.handle, repoKey }, signal());
    assert.equal((await current('a')).result.snapshotID, null);
    const begin = (repoKey: string, snapshotID: string | null) => bridge.request({ kind: 'beginGitSnapshot', root: root.handle, repoKey, snapshotID }, signal());
    const first: NativeReply<'beginGitSnapshot'> = await begin('a', null);
    assert.match(first.result.snapshotID, /^\d{4}-\d{2}-\d{2}\/\d{4}$/);
    const second: NativeReply<'beginGitSnapshot'> = await begin('a', null);
    assert.notEqual(second.result.snapshotID, first.result.snapshotID);
    if (second.result.snapshotID.startsWith(first.result.snapshotID)) {
      assert.equal(second.result.snapshotID, first.result.snapshotID + '-2');
    } else {
      assert.match(second.result.snapshotID, /^\d{4}-\d{2}-\d{2}\/\d{4}$/);
    }
    const other: NativeReply<'beginGitSnapshot'> = await begin('b', first.result.snapshotID);
    await bridge.request({ kind: 'writeGitSnapshotFile', run: first.result.run, path: 'MAP.txt', bytes: Buffer.from('first').toString('base64') }, signal());
    await bridge.request({ kind: 'writeGitSnapshotCurrent', run: first.result.run }, signal());
    assert.equal((await current('a')).result.snapshotID, first.result.snapshotID); assert.equal((await current('b')).result.snapshotID, null);
    const pointer = join(output, '_git_data/repos/a/CURRENT');
    assert.equal(await readlink(pointer), first.result.snapshotID);
    const bytes = await bridge.request({ kind: 'readGitSnapshotFile', root: root.handle, repoKey: 'a', snapshotID: first.result.snapshotID, path: 'MAP.txt' }, signal());
    assert.equal(Buffer.from(bytes.result.bytes, 'base64').toString(), 'first');
    await unlink(pointer); await writeFile(pointer, '\n ' + first.result.snapshotID + ' \n');
    assert.equal((await current('a')).result.snapshotID, first.result.snapshotID);
    await bridge.request({ kind: 'writeGitSnapshotCurrent', run: second.result.run }, signal());
    assert.equal(await readlink(pointer), second.result.snapshotID);
    const replaced: NativeReply<'beginGitSnapshot'> = await begin('a', first.result.snapshotID);
    assert.deepEqual(await readdir(join(output, replaced.result.relativePath)), []);
    await assert.rejects(bridge.request({ kind: 'writeGitSnapshotCurrent', run: first.result.run }, signal()), /outputChanged/);
    await assert.rejects(bridge.request({ kind: 'readGitSnapshotFile', root: root.handle, repoKey: 'a', snapshotID: first.result.snapshotID, path: '../CURRENT' }, signal()), /invalidRequest/);
    await writeFile(join(outside, 'untouched.txt'), 'outside');
    await symlink(outside, join(output, '_git_data/repos/a/hostile'));
    await assert.rejects(begin('a', 'hostile'), /symlink/);
    assert.equal(await readFile(join(outside, 'untouched.txt'), 'utf8'), 'outside');
    assert.equal((await current('a')).result.snapshotID, second.result.snapshotID);
    for (const entry of currentCases.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-current/cases.json', 'utf8')))) {
      const repository = join(root.identity.canonicalPath, '_git_data/repos', entry.name);
      await mkdir(repository, { recursive: true });
      if (entry.exists) await mkdir(join(repository, 'dated/one'), { recursive: true });
      if (entry.kind === 'file') await writeFile(join(repository, 'CURRENT'), entry.target);
      else if (entry.kind !== 'missing') await symlink(entry.kind === 'absoluteSymlink' ? join(repository, entry.target) : entry.target,
        join(repository, 'CURRENT'));
      const actual: NativeReply<'readGitSnapshotCurrent'> = await current(entry.name);
      assert.equal(actual.result.snapshotID, entry.expected, entry.name);
      proof.push({ name: entry.name, actual: actual.result });
    }
    proof.push({ first: first.result, second: second.result, other: other.result, replaced: replaced.result,
      oldCapabilityRevoked: true, outsideUntouched: true, current: (await current('a')).result });
    await writeFile('test-output/git-snapshot-current-proof.json', JSON.stringify(proof, null, 2) + '\n');
  } finally { await bridge.close(); await supervisor.close(); }
});

test('cancelling CURRENT publication retains the previous pointer and completed snapshot files', async t => {
  const output = await mkdtemp(join(tmpdir(), 'smip-current-cancel-'));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 }), children: OwnedProcess[] = [];
  const spawn = supervisor.spawn.bind(supervisor);
  t.mock.method(supervisor, 'spawn', (spec: ProcessSpec) => { const child = spawn(spec); children.push(child); return child; });
  const bridge = new BridgeClient({ supervisor, executable, env: {} });
  try {
    const opened = await bridge.request({ kind: 'openRoots', roots: [{ name: 'out', absolutePath: output, access: 'output', expected: null }] }, signal());
    const root = opened.result.roots[0]; assert(root);
    const first = await bridge.request({ kind: 'beginGitSnapshot', root: root.handle, repoKey: 'a', snapshotID: 'before' }, signal());
    await bridge.request({ kind: 'writeGitSnapshotCurrent', run: first.result.run }, signal());
    const next = await bridge.request({ kind: 'beginGitSnapshot', root: root.handle, repoKey: 'a', snapshotID: 'after' }, signal());
    await bridge.request({ kind: 'writeGitSnapshotFile', run: next.result.run, path: 'MAP.txt', bytes: Buffer.from('published body').toString('base64') }, signal());
    const child = children[0]; assert(child); assert.equal(child.child.kill('SIGSTOP'), true);
    const controller = new AbortController();
    const pending = bridge.request({ kind: 'writeGitSnapshotCurrent', run: next.result.run }, controller.signal);
    controller.abort(); await assert.rejects(pending, /cancelled/);
    await bridge.close(); const closed = await child.closed;
    assert.equal(await readlink(join(output, '_git_data/repos/a/CURRENT')), 'before');
    assert.equal(await readFile(join(output, next.result.relativePath, 'MAP.txt'), 'utf8'), 'published body');
    await writeFile('test-output/git-snapshot-current-cancel-proof.json', JSON.stringify({ closed, retainedBody: true, previousCurrent: true }, null, 2) + '\n');
  } finally { await bridge.close(); await supervisor.close(); }
});
