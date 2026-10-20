import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, unlink, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { BridgeClient } from '../src/native/bridge-client.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';

test('root reopening, alias retargeting and cancellation preserve owner boundaries', async () => {
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const options = { executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), supervisor, env: { REPOPROMPT_PCRE2_JIT: 'disabled' } };
  const first = new BridgeClient(options), second = new BridgeClient(options);
  const artifacts = resolve('test-output');
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, 'ownership-'));
  await mkdir(join(directory, 'source'));
  await mkdir(join(directory, 'replacement'));
  await writeFile(join(directory, 'source/file.swift'), 'struct Example {}');
  await symlink(join(directory, 'source'), join(directory, 'alias'));
  const declaration = { name: 'source', absolutePath: join(directory, 'alias'), access: 'source' as const, expected: null };
  const signal = new AbortController().signal;
  try {
    const opened = await first.request({ kind: 'openRoots', roots: [declaration] }, signal);

    const root = opened.result.roots[0]; assert(root);
    await assert.rejects(first.request({ kind: 'readSource', root: root.handle, path: 'line\n/../file.swift', expected: null }, signal), /invalidRequest/);
    const reopened = await second.request({ kind: 'openRoots', roots: [{ ...declaration, expected: root.identity }] }, signal);

    const current = reopened.result.roots[0]; assert(current);
    await assert.rejects(second.request({ kind: 'readSource', root: root.handle, path: 'file.swift', expected: null }, signal), /invalidRootHandle/);
    const abort = new AbortController();
    const cancelled = first.request({ kind: 'describe' }, abort.signal);
    abort.abort();
    await assert.rejects(cancelled, /cancelled/);
    const surviving = await second.request({ kind: 'readSource', root: current.handle, path: 'file.swift', expected: null }, signal);
    assert.equal(surviving.bytes.toString(), 'struct Example {}');
    await unlink(join(directory, 'alias'));
    await symlink(join(directory, 'replacement'), join(directory, 'alias'));
    await assert.rejects(second.request({ kind: 'readSource', root: current.handle, path: 'file.swift', expected: null }, signal), /rootChanged/);
    const devices = await second.request({ kind: 'openRoots', roots: [{ name: 'devices', absolutePath: '/dev', access: 'source', expected: null }] }, signal);

    const device = devices.result.roots[0]; assert(device);
    await assert.rejects(second.request({ kind: 'readSource', root: device.handle, path: 'null', expected: null }, signal), /nonRegularFile/);
  } finally { await first.close(); await second.close(); await supervisor.close(); }
});
