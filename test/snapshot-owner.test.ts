import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import type { OwnedProcess, ProcessSpec } from '../src/runtime/process-supervisor.js';

const signal = () => new AbortController().signal;
const referenceClockSeconds = 1700000000;
const fixture = Compile(Type.Object({ entries: Type.Array(Type.Object({ repoKey: Type.String(), snapshotID: Type.String(),
  generatedAt: Type.Number() })), publications: Type.Array(Type.Object({ repoKey: Type.String(), snapshotID: Type.String(),
  generatedAt: Type.Number() })), expected: Type.Object({ remaining: Type.Array(Type.String()) }) }));
const snapshots = Compile(Type.Array(Type.Object({ expected: Type.Array(Type.Object({ path: Type.String(), bytes: Type.String() })) })));
const manifest = Compile(Type.Record(Type.String(), Type.Unknown()));

test('distinct workspaces sharing an output root retain one authoritative retention cache', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-snapshot-owner-')), output = join(base, 'out');
  const roots = [join(base, 'a'), join(base, 'b')];
  await mkdir(output);
  for (const path of roots) { await mkdir(path); await writeFile(join(path, 'source.txt'), 'source\n'); }
  const input = fixture.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-retention/cache-owner.json', 'utf8')));
  const source = snapshots.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-snapshot/cases.json', 'utf8')))[0]; assert(source);
  const saved = source.expected.find(file => file.path === 'manifest.json'); assert(saved);
  const original = manifest.Parse(JSON.parse(Buffer.from(saved.bytes, 'base64').toString('utf8')));
  const seed = async (row: typeof input.entries[number]) => {
    const path = join(output, '_git_data/repos', row.repoKey, row.snapshotID); await mkdir(path, { recursive: true });
    await writeFile(join(path, 'manifest.json'), JSON.stringify({ ...original, repoKey: row.repoKey,
      snapshotID: row.snapshotID, generatedAt: new Date(row.generatedAt * 1000).toISOString().replace('.000', '') }));
    await writeFile(join(path, 'MAP.txt'), row.snapshotID);
  };
  // Keep fixture ages within the source's seven-day admission window.
  const offset = Math.floor(Date.now() / 1000) - referenceClockSeconds;
  const shifted = (row: typeof input.entries[number]) => ({ ...row, generatedAt: row.generatedAt + offset });
  for (const row of input.entries) await seed(shifted(row));
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000 });
  try {
    const a = await runtime.declare({ roots: [{ name: 'a', absolutePath: roots[0]! }], exclusions: [], outputRoot: output }, signal());
    const b = await runtime.declare({ roots: [{ name: 'b', absolutePath: roots[1]! }], exclusions: [], outputRoot: output }, signal());
    const operations = [await a.openOperation(signal()), await b.openOperation(signal())];
    try {
      const indexPath = join(output, '_git_data/retention-index.json'), oldIndex = await readFile(indexPath);
      for (const [index, publication] of input.publications.entries()) {
        const operation = operations[index]; assert(operation);
        const row = shifted(publication);
        await runtime.mutateGitSnapshots(operation.snapshot.outputRoot, signal(), async (combined, access) => {
          await seed(row);
          await access.bridge.request({ kind: 'maintainGitSnapshots', root: access.root,
            action: { kind: 'published', repoKey: row.repoKey, snapshotID: row.snapshotID,
              generatedAt: new Date(row.generatedAt * 1000).toISOString().replace('.000', '') } }, combined);
        });
        if (index === 0) await writeFile(indexPath, oldIndex);
      }
      const remaining = [];
      for (const repoKey of ['a', 'b']) for (const name of await readdir(join(output, '_git_data/repos', repoKey))) {
        if (name !== 'CURRENT') remaining.push(repoKey + '/' + name);
      }
      assert.deepEqual(remaining.sort(), input.expected.remaining);
      await mkdir('test-output', { recursive: true });
      await writeFile('test-output/snapshot-owner-proof.json', JSON.stringify({ remaining,
        distinctSourceWorkspaces: true, sourceCacheSurvivesStaleDiskIndex: true }, null, 2) + '\n');
    } finally { await Promise.all(operations.map(operation => operation.close())); await a.close(); await b.close(); }
  } finally { await runtime.close(); }
});

test('active mutation cancellation settles its worker; the next request reopens the same root identity', async t => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-snapshot-owner-cancel-')), output = join(base, 'out'); await mkdir(output);
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000 });
  const children: OwnedProcess[] = [], spawn = runtime.supervisor.spawn.bind(runtime.supervisor);
  t.mock.method(runtime.supervisor, 'spawn', (spec: ProcessSpec) => { const child = spawn(spec); children.push(child); return child; });
  const helper = runtime.makeBridge();
  try {
    const opened = await helper.request({ kind: 'openRoots', roots: [{ name: 'out', absolutePath: output, access: 'output', expected: null }] }, signal());
    const root = opened.result.roots[0]; assert(root);
    const controller = new AbortController();
    let oldGeneration = '';
    await assert.rejects(runtime.mutateGitSnapshots(root.identity, controller.signal, async (combined, access) => {
      oldGeneration = access.root.generation;
      const snapshot = await access.bridge.request({ kind: 'beginGitSnapshot', root: access.root, repoKey: 'a', snapshotID: 'saved' }, combined);
      await access.bridge.request({ kind: 'writeGitSnapshotFile', run: snapshot.result.run, path: 'MAP.txt',
        bytes: Buffer.from('completed').toString('base64') }, combined);
      const worker = children.find(child => child.child.spawnargs.includes(oldGeneration)); assert(worker);
      assert(worker.child.kill('SIGSTOP'));
      const pending = access.bridge.request({ kind: 'maintainGitSnapshots', root: access.root, action: { kind: 'opened' } }, combined);
      controller.abort(); await pending;
    }), /cancelled|aborted/i);
    const retired = children.find(child => child.child.spawnargs.includes(oldGeneration)); assert(retired);
    await retired.closed;
    const recovered = await runtime.mutateGitSnapshots(root.identity, signal(), async (combined, access) => {
      assert.notEqual(access.root.generation, oldGeneration);
      const snapshot = await access.bridge.request({ kind: 'beginGitSnapshot', root: access.root, repoKey: 'a', snapshotID: 'finished' }, combined);
      await access.bridge.request({ kind: 'writeGitSnapshotFile', run: snapshot.result.run, path: 'MAP.txt',
        bytes: Buffer.from('retained after finish').toString('base64') }, combined);
      await access.bridge.request({ kind: 'finishGitSnapshot', run: snapshot.result.run }, combined);
      await assert.rejects(access.bridge.request({ kind: 'writeGitSnapshotFile', run: snapshot.result.run, path: 'MAP.txt', bytes: '' }, combined), /invalidExportHandle/);
      assert.equal(await readFile(join(output, '_git_data/repos/a/finished/MAP.txt'), 'utf8'), 'retained after finish');
      return (await access.bridge.request({ kind: 'readGitSnapshotFile', root: access.root, repoKey: 'a', snapshotID: 'saved', path: 'MAP.txt' }, combined)).result;
    });
    assert.equal(Buffer.from(recovered.bytes, 'base64').toString('utf8'), 'completed');
    await rename(output, output + '-original'); await mkdir(output);
    await assert.rejects(runtime.mutateGitSnapshots(root.identity, signal(), async () => {}), /rootChanged/);
    assert.equal(await readFile(join(output + '-original', '_git_data/repos/a/saved/MAP.txt'), 'utf8'), 'completed');
    await writeFile('test-output/snapshot-owner-cancel-proof.json', JSON.stringify({ cancelledWorkerSettled: true,
      laterRequestReopened: true, completedFileRetained: true, replacedRootRefused: true }, null, 2) + '\n');
  } finally { await helper.close(); await runtime.close(); }
  await Promise.all(children.map(child => child.closed));
});
