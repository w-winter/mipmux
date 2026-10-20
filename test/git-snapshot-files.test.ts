import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeGitSnapshotInput } from '../src/contracts/git-snapshot.js';
import { BridgeClient, NativeFailure, type NativeReply } from '../src/native/bridge-client.js';
import { ProcessSupervisor, type OwnedProcess, type ProcessSpec } from '../src/runtime/process-supervisor.js';

const signal = () => new AbortController().signal;
const cases = Compile(Type.Array(Type.Object({ name: Type.String(), input: NativeGitSnapshotInput })));
const failureInput = Type.Object({ name: Type.String(), ...Type.Pick(NativeGitSnapshotInput,
  ['mode', 'scope', 'requestedPaths', 'compare', 'compareInput', 'diffText', 'perFile', 'changedFiles', 'summary']).properties });

test('snapshot filesystem boundary preserves ordered bytes, rejects traversal and retains partial failures', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-snapshot-files-')), output = join(base, 'out'), outside = join(base, 'outside');
  await mkdir(output); await mkdir(outside);
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ supervisor, executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), env: {} });
  const proof: unknown[] = [];
  const failures: { code: string; errno: number | null }[] = [];
  try {
    const roots = await bridge.request({ kind: 'openRoots', roots: [
      { name: 'out', absolutePath: output, access: 'output', expected: null },
      { name: 'source', absolutePath: outside, access: 'source', expected: null },
    ] }, signal());
    const destination = roots.result.roots.find(root => root.name === 'out'); assert(destination);
    const source = roots.result.roots.find(root => root.name === 'source'); assert(source);
    const bundle = await bridge.request({ kind: 'beginExport', root: destination.handle, name: 'bundle' }, signal());
    await bridge.request({ kind: 'publishManifest', run: bundle.result.run, bytes: Buffer.from('{}').toString('base64') }, signal());
    await assert.rejects(bridge.request({ kind: 'writeGitSnapshotFile', run: bundle.result.run, path: 'manifest.json', bytes: '' }, signal()), /invalidExportHandle/);
    assert.equal(await readFile(join(output, 'bundle/manifest.json'), 'utf8'), '{}');
    await assert.rejects(bridge.request({ kind: 'beginGitSnapshot', root: source.handle, repoKey: 'fixture-repo', snapshotID: 'denied' }, signal()), /invalidOutputCapability/);
    await assert.rejects(bridge.request({ kind: 'beginGitSnapshot', root: destination.handle, repoKey: 'fixture-repo', snapshotID: '../escape' }, signal()), /invalidPath/);
    const fixtures = cases.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-snapshot/cases.json', 'utf8')));
    for (const fixture of fixtures) {
      const snapshotID = '2026-10-13/' + fixture.name;
      const rendered = await bridge.request({ kind: 'serializeGitSnapshot', input: { ...fixture.input, snapshotID } }, signal());
      const opened: NativeReply<'beginGitSnapshot'> = await bridge.request({ kind: 'beginGitSnapshot', root: destination.handle, repoKey: 'fixture-repo', snapshotID }, signal());
      const saved = new Map<string, string>();
      for (const file of rendered.result.files) {
        const written: NativeReply<'writeGitSnapshotFile'> = await bridge.request({ kind: 'writeGitSnapshotFile', run: opened.result.run, path: file.path, bytes: file.bytes }, signal());
        assert.equal(written.result.identity.byteCount, Buffer.from(file.bytes, 'base64').length);
        saved.set(file.path, file.bytes);
      }
      for (const [path, bytes] of saved) assert.deepEqual(await readFile(join(output, opened.result.relativePath, path)), Buffer.from(bytes, 'base64'));
      const replaced: NativeReply<'beginGitSnapshot'> = await bridge.request({ kind: 'beginGitSnapshot', root: destination.handle, repoKey: 'fixture-repo', snapshotID }, signal());
      assert.deepEqual(await readdir(join(output, replaced.result.relativePath)), []);
      await assert.rejects(bridge.request({ kind: 'writeGitSnapshotFile', run: opened.result.run, path: 'stale.txt', bytes: '' }, signal()), /outputChanged/);
      proof.push({ name: fixture.name, opened: opened.result, files: [...saved.keys()] });
    }
    const failed = await bridge.request({ kind: 'beginGitSnapshot', root: destination.handle, repoKey: 'fixture-repo', snapshotID: 'failure' }, signal());
    const directory = join(output, failed.result.relativePath), bytes = Buffer.from('retained earlier file');
    await bridge.request({ kind: 'writeGitSnapshotFile', run: failed.result.run, path: 'MAP.txt', bytes: bytes.toString('base64') }, signal());
    const fixture = fixtures.find(fixture => fixture.name === 'standard-filenames'); assert(fixture);
    const failure: unknown = JSON.parse(await readFile('test/fixtures/rpce-git-snapshot/source-failure.json', 'utf8'));
    const failureRecord = Compile(Type.Object({ input: failureInput })).Parse(failure);
    const { name: _name, ...input } = failureRecord.input;
    const rendered = await bridge.request({ kind: 'serializeGitSnapshot', input: { ...fixture.input, ...input, snapshotID: 'failure' } }, signal());
    await assert.rejects(async () => {
      for (const file of rendered.result.files) await bridge.request({ kind: 'writeGitSnapshotFile', run: failed.result.run, path: file.path, bytes: file.bytes }, signal());
    }, error => {
      assert(error instanceof NativeFailure); assert.equal(error.code, 'nativeIOFailed'); assert.notEqual(error.errno, null);
      failures.push({ code: error.code, errno: error.errno }); return true;
    });
    assert.deepEqual(await readFile(join(directory, 'MAP.txt')), bytes);
    assert(!(await readdir(join(directory, 'diff/per-file'))).some(path => path.startsWith('.snapshot-')));
    await symlink(outside, join(directory, 'linked'));
    await assert.rejects(bridge.request({ kind: 'writeGitSnapshotFile', run: failed.result.run, path: 'linked/stolen.txt', bytes: '' }, signal()));
    assert.deepEqual(await readdir(outside), []);
    await writeFile(join(directory, 'stable.txt'), 'stable');
    await rename(directory, directory + '-replaced'); await mkdir(directory);
    await assert.rejects(bridge.request({ kind: 'writeGitSnapshotFile', run: failed.result.run, path: 'stable.txt', bytes: '' }, signal()), /outputChanged/);
    assert.equal(await readFile(join(directory + '-replaced', 'stable.txt'), 'utf8'), 'stable');
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/git-snapshot-files-proof.json', JSON.stringify({ proof, failures,
      outsideUntouched: true, partialRetained: true, bundleManifestUnchanged: true }, null, 2) + '\n');
  } finally { await bridge.close(); await supervisor.close(); }
});

test('cancelling a snapshot request joins its worker and retains completed files', async t => {
  const output = await mkdtemp(join(tmpdir(), 'mipmux-snapshot-cancel-'));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 }), children: OwnedProcess[] = [];
  const spawn = supervisor.spawn.bind(supervisor);
  t.mock.method(supervisor, 'spawn', (spec: ProcessSpec) => { const child = spawn(spec); children.push(child); return child; });
  const bridge = new BridgeClient({ supervisor, executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), env: {} });
  try {
    const roots = await bridge.request({ kind: 'openRoots', roots: [{ name: 'out', absolutePath: output, access: 'output', expected: null }] }, signal());
    const destination = roots.result.roots[0]; assert(destination);
    const opened = await bridge.request({ kind: 'beginGitSnapshot', root: destination.handle, repoKey: 'fixture-repo', snapshotID: 'cancel' }, signal());
    const bytes = Buffer.from('completed snapshot file');
    await bridge.request({ kind: 'writeGitSnapshotFile', run: opened.result.run, path: 'MAP.txt', bytes: bytes.toString('base64') }, signal());
    const child = children[0]; assert(child); assert.equal(child.child.kill('SIGSTOP'), true);
    const controller = new AbortController();
    const pending = bridge.request({ kind: 'writeGitSnapshotFile', run: opened.result.run, path: 'manifest.json', bytes: '' }, controller.signal);
    controller.abort(); await assert.rejects(pending, /cancelled/);
    await bridge.close(); const closed = await child.closed;
    assert(closed.code !== null || closed.signal !== null);
    const directory = join(output, opened.result.relativePath);
    assert.deepEqual(await readFile(join(directory, 'MAP.txt')), bytes);
    assert.deepEqual(await readdir(directory), ['MAP.txt']);
    await writeFile('test-output/git-snapshot-cancel-proof.json', JSON.stringify({ closed, completedFileRetained: true, cancelledFileAbsent: true }, null, 2) + '\n');
  } finally { await bridge.close(); await supervisor.close(); }
});
