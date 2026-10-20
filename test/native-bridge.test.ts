import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { BridgeClient } from '../src/native/bridge-client.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';

const executable = resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`);
const signal = () => new AbortController().signal;
const identity = (bytes: Buffer) => ({ sha256: createHash('sha256').update(bytes).digest('hex'), byteCount: bytes.length });

test('native exact-byte acquisition, extraction, confined reads and exclusive export', async () => {
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ executable, supervisor, env: { REPOPROMPT_PCRE2_JIT: 'required' } });
  const artifacts = resolve('test-output');
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, 'native-'));
  const output = join(root, 'out');
  await mkdir(output);
  try {
    const description = await bridge.request({ kind: 'describe' }, signal());
    assert.equal(description.result.kind, 'description');

    assert.equal(description.result.engine.version, '10.49 2026-09-28');
    assert.equal(description.result.engine.jitExecution, 'compiled');
    assert.equal(description.result.extensions.length, 13);
    const opened = await bridge.request({ kind: 'openRoots', roots: [
      { name: 'source', absolutePath: root, access: 'source', expected: null },
      { name: 'output', absolutePath: output, access: 'output', expected: null },
    ] }, signal());

    const source = opened.result.roots[0];
    const destination = opened.result.roots[1];
    assert(source && destination);
    const bytes = Buffer.from('\uFEFFstruct Example {\r\n let title: String = "é🙂"\r}\n');
    const unusualName = 'line\n\u2028e\u0301.swift';
    await writeFile(join(root, unusualName), bytes);
    const unusualRead = await bridge.request({ kind: 'readSource', root: source.handle, path: unusualName, expected: identity(bytes) }, signal());
    assert.deepEqual(unusualRead.bytes, bytes);
    await writeFile(join(root, 'example.swift'), bytes);
    const read = await bridge.request({ kind: 'readSource', root: source.handle, path: 'example.swift', expected: identity(bytes) }, signal());
    assert.equal(read.result.kind, 'sourceComplete');

    assert.equal(read.result.fingerprint.mode & 0o170000, 0o100000);
    assert.deepEqual(read.bytes, bytes);
    const extracted = await bridge.request({ kind: 'extract', extension: 'swift', bytes: bytes.toString('base64'), expected: identity(bytes) }, signal());
    if (extracted.result.kind !== 'extracted') assert.fail('Missing extraction');
    assert.equal(extracted.result.outcome.kind, 'ready');
    assert.deepEqual(extracted.result.key, read.result.key);
    const invalid = Buffer.from([0xff, 0xfe, 0x00, 0xd8]);
    const failedDecode = await bridge.request({ kind: 'extract', extension: 'swift', bytes: invalid.toString('base64'), expected: identity(invalid) }, signal());
    if (failedDecode.result.kind !== 'extracted') assert.fail('Missing decode outcome');
    assert.equal(failedDecode.result.outcome.kind, 'decodeFailed');
    await assert.rejects(bridge.request({ kind: 'extract', extension: 'swift', bytes: invalid.toString('base64'), expected: identity(bytes) }, signal()), /sourceChanged/);
    await symlink('/etc/passwd', join(root, 'escape'));
    await assert.rejects(bridge.request({ kind: 'readSource', root: source.handle, path: 'escape', expected: null }, signal()), /symlink/);
    execFileSync('mkfifo', [join(root, 'fifo')]);
    await assert.rejects(bridge.request({ kind: 'readSource', root: source.handle, path: 'fifo', expected: null }, signal()), /nonRegularFile/);
    await mkdir(join(root, 'parent'));
    await rename(join(root, 'parent'), join(root, 'original-parent'));
    await symlink('/etc', join(root, 'parent'));
    await assert.rejects(bridge.request({ kind: 'readSource', root: source.handle, path: 'parent/passwd', expected: null }, signal()));
    const listing = await bridge.request({ kind: 'listDirectory', root: source.handle, directory: { kind: 'root' } }, signal());
    assert.equal(listing.result.kind, 'directoryComplete');
    assert(listing.entries.some(entry => entry.name === 'escape' && entry.entryKind === 'symlink'));
    const run = await bridge.request({ kind: 'beginExport', root: destination.handle, name: 'run' }, signal());

    await bridge.request({ kind: 'writeExport', run: run.result.run, filename: 'context.md', bytes: bytes.toString('base64') }, signal());
    await assert.rejects(bridge.request({ kind: 'writeExport', run: run.result.run, filename: 'context.md', bytes: '' }, signal()), /alreadyExists/);
    const readback = await bridge.request({ kind: 'readExport', run: run.result.run, filename: 'context.md' }, signal());

    assert.deepEqual(Buffer.from(readback.result.bytes, 'base64'), bytes);
    await bridge.request({ kind: 'publishManifest', run: run.result.run, bytes: Buffer.from('{}').toString('base64') }, signal());
    assert.equal(await readFile(join(output, 'run/manifest.json'), 'utf8'), '{}');
    const redirected = await bridge.request({ kind: 'beginExport', root: destination.handle, name: 'redirected' }, signal());

    await rename(join(output, 'redirected'), join(output, 'original-run'));
    await symlink(root, join(output, 'redirected'));
    await assert.rejects(bridge.request({ kind: 'writeExport', run: redirected.result.run, filename: 'handoff.md', bytes: '' }, signal()));
    await assert.rejects(readFile(join(root, 'handoff.md')), { code: 'ENOENT' });
    await rename(root, root + '-replaced');
    await mkdir(root);
    await assert.rejects(bridge.request({ kind: 'readSource', root: source.handle, path: 'example.swift', expected: null }, signal()), /rootChanged/);
  } finally {
    await bridge.close();
    await supervisor.close();
  }
});
