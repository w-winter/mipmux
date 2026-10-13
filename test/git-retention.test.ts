import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { BridgeClient, type NativeReply } from '../src/native/bridge-client.js';
import { ProcessSupervisor, type OwnedProcess, type ProcessSpec } from '../src/runtime/process-supervisor.js';
import type { NativeHandle } from '../src/contracts/native.js';

const signal = () => new AbortController().signal;
const row = Type.Object({ repoKey: Type.String(), snapshotID: Type.String(), generatedAt: Type.Number(), tabID: Type.Union([Type.String(), Type.Null()]) });
const fixture = Compile(Type.Array(Type.Object({ name: Type.String(), entries: Type.Array(row), operation: Type.Union([
  Type.Object({ kind: Type.Literal('published') }), Type.Object({ kind: Type.Literal('opened'), lastCleanupAt: Type.Number() }),
  Type.Object({ kind: Type.Literal('closed'), tabIDs: Type.Array(Type.String()) }),
]), expected: Type.Object({ remaining: Type.Array(Type.String()), pointers: Type.Array(Type.Object({ repoKey: Type.String(),
  readCurrent: Type.Union([Type.String(), Type.Null()]), link: Type.Union([Type.String(), Type.Null()]) })), result: Type.Unknown() }) })));
const object = Compile(Type.Record(Type.String(), Type.Unknown()));
const index = Compile(Type.Object({ version: Type.Integer(), entries: Type.Array(Type.Object({ repoKey: Type.String(),
  snapshotID: Type.String(), generatedAt: Type.String() })) }));

async function seedSnapshot(bridge: BridgeClient, root: NativeHandle, entry: Static<typeof row>, shift: number) {
  const begun: NativeReply<'beginGitSnapshot'> = await bridge.request({ kind: 'beginGitSnapshot', root, repoKey: entry.repoKey, snapshotID: entry.snapshotID }, signal());
  const date = new Date((entry.generatedAt + shift) * 1000).toISOString().replace('.000', '');
  const rendered = await bridge.request({ kind: 'serializeGitSnapshot', input: { snapshotID: entry.snapshotID, repoKey: entry.repoKey,
    mode: 'quick', scope: 'all', requestedPaths: null, compare: 'uncommitted', compareInput: null, diffText: null, perFile: null,
    changedFiles: [], summary: { files: 0, insertions: 0, deletions: 0 }, fingerprint: { headSHA: 'a'.repeat(40), baseRef: 'HEAD',
      statusHash: 'fixture', generatedAt: date }, contextLines: 3, detectRenames: false, commitGraph: '', repoRoot: null,
    tabID: entry.tabID, worktree: null } }, signal());
  for (const file of rendered.result.files) {
    let bytes = file.bytes;
    if (file.path === 'manifest.json') {
      const value = object.Parse(JSON.parse(Buffer.from(bytes, 'base64').toString()));
      value.generatedAt = date;
      bytes = Buffer.from(JSON.stringify(value)).toString('base64');
    }
    await bridge.request({ kind: 'writeGitSnapshotFile', run: begun.result.run, path: file.path, bytes }, signal());
  }
  await bridge.request({ kind: 'writeGitSnapshotCurrent', run: begun.result.run }, signal());
}

async function verifyPointers(bridge: BridgeClient, root: NativeHandle, output: string, entry: ReturnType<typeof fixture.Parse>[number]) {
  for (const pointer of entry.expected.pointers) {
    const current: NativeReply<'readGitSnapshotCurrent'> = await bridge.request({ kind: 'readGitSnapshotCurrent', root, repoKey: pointer.repoKey }, signal());
    const link = join(output, '_git_data/repos', pointer.repoKey, 'CURRENT');
    if (entry.name === 'publish-ties') {
      const retained = entry.entries.filter(row => row.repoKey === pointer.repoKey &&
        entry.expected.remaining.includes(row.repoKey + '/' + row.snapshotID));
      const newest = Math.max(...retained.map(row => row.generatedAt));
      assert(retained.some(row => row.generatedAt === newest && row.snapshotID === current.result.snapshotID));
      assert.equal(await readlink(link), current.result.snapshotID);
    } else {
      assert.equal(current.result.snapshotID, pointer.readCurrent, entry.name);
      if (pointer.link !== null) assert.equal(await readlink(link), pointer.link, entry.name);
    }
  }
}

test('confined retention matches original count, age, throttle and explicit owner-disposal outcomes', async () => {
  await mkdir('test-output', { recursive: true });
  const cases = fixture.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-retention/cases.json', 'utf8')));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ supervisor, executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), env: {} });
  const proof: unknown[] = [], shift = Math.floor(Date.now() / 1000) - 1700000000;
  try {
    for (const entry of cases) {
      const output = await mkdtemp(join(tmpdir(), 'smip-retention-'));
      const opened = await bridge.request({ kind: 'openRoots', roots: [{ name: 'out', absolutePath: output, access: 'output', expected: null }] }, signal());
      const root = opened.result.roots[0]; assert(root);
      for (const row of entry.entries) await seedSnapshot(bridge, root.handle, row, shift);
      let action;
      if (entry.operation.kind === 'published') {
        const last = entry.entries.at(-1); assert(last);
        action = { kind: 'published' as const, repoKey: last.repoKey, snapshotID: last.snapshotID,
          generatedAt: new Date((last.generatedAt + shift) * 1000).toISOString().replace('.000', '') };
      } else if (entry.operation.kind === 'opened') {
        await writeFile(join(output, '_git_data/maintenance.json'), JSON.stringify({ version: 2,
          lastCleanupAt: new Date((entry.operation.lastCleanupAt + shift) * 1000).toISOString().replace('.000', '') }));
        action = { kind: 'opened' as const };
      } else action = entry.operation;
      const maintained = await bridge.request({ kind: 'maintainGitSnapshots', root: root.handle, action }, signal());
      const listed = await bridge.request({ kind: 'listGitSnapshots', root: root.handle }, signal());
      assert.deepEqual(listed.result.snapshots.map(row => row.repoKey + '/' + row.snapshotID).sort(), entry.expected.remaining, entry.name);
      await verifyPointers(bridge, root.handle, output, entry);
      assert.deepEqual(maintained.result.outcome, entry.expected.result, entry.name);
      if (entry.operation.kind === 'published' || entry.name === 'open-age') {
        const stored = index.Parse(JSON.parse(await readFile(join(output, '_git_data/retention-index.json'), 'utf8')));
        assert.equal(stored.version, 1);
        assert.deepEqual(stored.entries.map(row => row.repoKey + '/' + row.snapshotID).sort(), entry.expected.remaining);
      }
      proof.push({ name: entry.name, maintained: maintained.result, listed: listed.result });
    }
    await writeFile('test-output/git-retention-proof.json', JSON.stringify(proof, null, 2) + '\n');
  } finally { await bridge.close(); await supervisor.close(); }
});

test('retention refuses source capabilities and obsolete state before changing stored bytes', async () => {
  const output = await mkdtemp(join(tmpdir(), 'smip-retention-state-'));
  await mkdir(join(output, '_git_data'));
  const bytes = JSON.stringify({ version: 1, lastCleanupAt: '2023-11-14T22:13:20Z' });
  await writeFile(join(output, '_git_data/maintenance.json'), bytes);
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ supervisor, executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), env: {} });
  try {
    const opened = await bridge.request({ kind: 'openRoots', roots: [{ name: 'out', absolutePath: output, access: 'output', expected: null }] }, signal());
    const root = opened.result.roots[0]; assert(root);
    await assert.rejects(bridge.request({ kind: 'maintainGitSnapshots', root: root.handle, action: { kind: 'opened' } }, signal()), /unsupportedSnapshotState/);
    const source = await bridge.request({ kind: 'openRoots', roots: [{ name: 'source', absolutePath: output, access: 'source', expected: null }] }, signal());
    const sourceRoot = source.result.roots[0]; assert(sourceRoot);
    await assert.rejects(bridge.request({ kind: 'maintainGitSnapshots', root: sourceRoot.handle, action: { kind: 'opened' } }, signal()), /invalidOutputCapability/);
    assert.equal(await readFile(join(output, '_git_data/maintenance.json'), 'utf8'), bytes);
    assert.deepEqual(await readdir(join(output, '_git_data')), ['maintenance.json']);
  } finally { await bridge.close(); await supervisor.close(); }
});

test('cancelling queued retention joins the worker and leaves completed snapshot files', async t => {
  const output = await mkdtemp(join(tmpdir(), 'smip-retention-cancel-'));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 }), children: OwnedProcess[] = [];
  const spawn = supervisor.spawn.bind(supervisor);
  t.mock.method(supervisor, 'spawn', (spec: ProcessSpec) => { const child = spawn(spec); children.push(child); return child; });
  const bridge = new BridgeClient({ supervisor, executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), env: {} });
  try {
    const opened = await bridge.request({ kind: 'openRoots', roots: [{ name: 'out', absolutePath: output, access: 'output', expected: null }] }, signal());
    const root = opened.result.roots[0]; assert(root);
    const snapshot = await bridge.request({ kind: 'beginGitSnapshot', root: root.handle, repoKey: 'a', snapshotID: 'saved' }, signal());
    await bridge.request({ kind: 'writeGitSnapshotFile', run: snapshot.result.run, path: 'MAP.txt', bytes: Buffer.from('completed').toString('base64') }, signal());
    const child = children[0]; assert(child); assert(child.child.kill('SIGSTOP'));
    const controller = new AbortController();
    const pending = bridge.request({ kind: 'maintainGitSnapshots', root: root.handle, action: { kind: 'opened' } }, controller.signal);
    controller.abort(); await assert.rejects(pending, /cancelled/); await bridge.close(); const closed = await child.closed;
    assert.equal(await readFile(join(output, snapshot.result.relativePath, 'MAP.txt'), 'utf8'), 'completed');
    await writeFile('test-output/git-retention-cancel-proof.json', JSON.stringify({ closed, retainedSnapshot: true }, null, 2) + '\n');
  } finally { await bridge.close(); await supervisor.close(); }
});
