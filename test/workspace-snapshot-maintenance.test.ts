import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';

const object = Compile(Type.Record(Type.String(), Type.Unknown()));
const reference = Compile(Type.Array(Type.Object({ expected: Type.Array(Type.Object({ path: Type.String(), bytes: Type.String() })) })));
const signal = () => new AbortController().signal;

test('workspace admission applies full snapshot maintenance and shutdown retains completed snapshots', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-workspace-maintenance-')), root = join(base, 'root'), output = join(base, 'out');
  await mkdir(root); await mkdir(output); await writeFile(join(root, 'file.txt'), 'source\n');
  const fixtures = reference.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-snapshot/cases.json', 'utf8')));
  const fixture = fixtures[0]; assert(fixture);
  for (const [name, ageDays] of [['old', 8], ['recent', 1]] as const) {
    const directory = join(output, '_git_data/repos/a', name);
    await mkdir(directory, { recursive: true });
    const manifest = fixture.expected.find(file => file.path === 'manifest.json'); assert(manifest);
    const value = object.Parse(JSON.parse(Buffer.from(manifest.bytes, 'base64').toString()));
    value.repoKey = 'a'; value.snapshotID = name; value.generatedAt = new Date(Date.now() - ageDays * 86400000).toISOString();
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(value));
    await writeFile(join(directory, 'MAP.txt'), name);
  }
  await symlink('old', join(output, '_git_data/repos/a/CURRENT'));
  const options = { cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000 };
  const runtime = new SmipRuntime(options);
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, signal());
    assert.deepEqual((await readdir(join(output, '_git_data/repos/a'))).sort(), ['CURRENT', 'recent']);
    assert.equal(await readlink(join(output, '_git_data/repos/a/CURRENT')), 'recent');
    await workspace.close();
  } finally { await runtime.close(); }
  assert.equal(await readFile(join(output, '_git_data/repos/a/recent/MAP.txt'), 'utf8'), 'recent');
  const reopened = new SmipRuntime(options);
  try {
    const workspace = await reopened.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, signal());
    assert.equal(await readFile(join(output, '_git_data/repos/a/recent/MAP.txt'), 'utf8'), 'recent'); await workspace.close();
  } finally { await reopened.close(); }
  await writeFile('test-output/workspace-snapshot-maintenance-proof.json', JSON.stringify({ expiredRemoved: true,
    currentUpdated: true, retainedAcrossShutdown: true, retainedAcrossRestart: true }, null, 2) + '\n');
});

test('a cancelled queued snapshot mutation does not bypass its predecessor', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-snapshot-queue-')), output = join(base, 'out'); await mkdir(output);
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000 });
  const bridge = runtime.makeBridge(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const opened = await bridge.request({ kind: 'openRoots', roots: [{ name: 'out', absolutePath: output, access: 'output', expected: null }] }, signal());
    const root = opened.result.roots[0]; assert(root); const file = join(output, 'order.txt');
    const first = runtime.mutateGitSnapshots(root.identity, signal(), async () => {
      entered(); await gate; writeFileSync(file, 'first');
    });
    await started;
    const controller = new AbortController();
    const cancelled = runtime.mutateGitSnapshots(root.identity, controller.signal, async () => { writeFileSync(file, 'cancelled'); });
    controller.abort(); await assert.rejects(cancelled, /cancelled|aborted/i);
    const third = runtime.mutateGitSnapshots(root.identity, signal(), async () => { writeFileSync(file, 'third'); });
    await setImmediate(); release(); await Promise.all([first, third]);
    assert.equal(await readFile(file, 'utf8'), 'third');
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(runtime.mutateGitSnapshots(root.identity, aborted.signal, async () => { writeFileSync(file, 'preaborted'); }), /cancelled|aborted/i);
    assert.equal(await readFile(file, 'utf8'), 'third');
    await writeFile('test-output/workspace-snapshot-queue-proof.json', JSON.stringify({ orderedFinalValue: 'third', cancelledSkipped: true,
      preabortedSkipped: true }, null, 2) + '\n');
  } finally { release(); await bridge.close(); await runtime.close(); }
});
