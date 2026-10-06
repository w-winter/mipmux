import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import { once } from 'node:events';
import { BridgeClient, NativeWorkerFailure } from '../src/native/bridge-client.js';
import { ProcessSupervisor, type OwnedProcess, type ProcessSpec } from '../src/runtime/process-supervisor.js';

test('idle fragments retire before another request is dispatched', async () => {
  for (const fragment of ['{', '{"wireVersion":1}\n']) {
    let owned!: OwnedProcess;
    class Supervisor extends ProcessSupervisor { override spawn(spec: ProcessSpec) { return owned = super.spawn(spec); } }
    const supervisor = new Supervisor({ terminationGraceMs: 20 });
    const client = new BridgeClient({ executable: resolve('test/fixtures/native-worker.mjs'), supervisor,
      env: { PATH: dirname(process.execPath), SCENARIO: 'idleFragment', FRAGMENT: fragment } });
    try {
      await client.request({ kind: 'extract', extension: 'unsupported', bytes: '', expected: {
        sha256: createHash('sha256').update('').digest('hex'), byteCount: 0 } }, new AbortController().signal);
      const received = once(owned.child.stdout, 'data');
      owned.child.stdin.write('fragment\n');
      await received;
      const closing = once(owned.child, 'exit');
      let dispatched = false;
      const originalWrite = owned.child.stdin.write.bind(owned.child.stdin);
      owned.child.stdin.write = new Proxy(originalWrite, { apply(target, receiver, args) {
        dispatched = true; return Reflect.apply(target, receiver, args);
      } });
      const next = assert.rejects(client.request({ kind: 'describe' }, new AbortController().signal), /nativeProtocolError/);
      await Promise.resolve(); await Promise.resolve();
      assert.equal(dispatched, false, 'unsolicited fragment must retire at ingress');
      await next; await closing;
    } finally { await client.close(); await supervisor.close(); }
  }
});

test('a controlled active fragment remains part of its original reply', async () => {
  let owned!: OwnedProcess;
  class Supervisor extends ProcessSupervisor { override spawn(spec: ProcessSpec) { return owned = super.spawn(spec); } }
  const supervisor = new Supervisor({ terminationGraceMs: 20 });
  const client = new BridgeClient({ executable: resolve('test/fixtures/native-worker.mjs'), supervisor,
    env: { PATH: dirname(process.execPath), SCENARIO: 'activeFragment' } });
  try {
    const received = once(owned.child.stdout, 'data');
    const reply = client.request({ kind: 'extract', extension: 'unsupported', bytes: '', expected: {
      sha256: createHash('sha256').update('').digest('hex'), byteCount: 0 } }, new AbortController().signal);
    await received;
    owned.child.stdin.write('complete\n');
    assert.equal((await reply).result.kind, 'unsupportedExtension');
  } finally { await client.close(); await supervisor.close(); }
});

test('malformed responses retire the worker and reject queued operations', async () => {
  for (const scenario of ['wrongKind', 'wrongId', 'wrongGeneration', 'wrongVersion', 'partial', 'invalidUTF8', 'duplicate', 'emptyClose']) {
    const supervisor = new ProcessSupervisor({ terminationGraceMs: 20 });
    const client = new BridgeClient({ executable: resolve('test/fixtures/native-worker.mjs'), supervisor,
      env: { PATH: dirname(process.execPath), SCENARIO: scenario } });
    const operation = { kind: 'extract' as const, extension: 'unsupported', bytes: '', expected: { sha256: createHash('sha256').update('').digest('hex'), byteCount: 0 } };
    try {
      const results = await Promise.allSettled([
        client.request(operation, new AbortController().signal),
        client.request(operation, new AbortController().signal),
      ]);
      assert(results.every(result => result.status === 'rejected'), scenario);
      if (scenario === 'emptyClose') {
        const result = results[0];
        assert(result?.status === 'rejected' && result.reason instanceof NativeWorkerFailure);
        assert.equal(result.reason.receipt.code, 23);
        assert.deepEqual(result.reason.sourceIdentity, operation.expected);
      }
      await assert.rejects(client.request(operation, new AbortController().signal));
    } finally {
      await client.close();
      await supervisor.close();
    }
  }
});

test('partial source bytes require an agreeing terminal identity', async () => {
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 20 });
  const client = new BridgeClient({ executable: resolve('test/fixtures/native-worker.mjs'), supervisor,
    env: { PATH: dirname(process.execPath), SCENARIO: 'badSourceReceipt' } });
  try {
    await assert.rejects(client.request({ kind: 'readSource', root: { generation: 'fixture', id: 'fixture' },
      path: 'source.swift', expected: null }, new AbortController().signal), /nativeProtocolError/);
  } finally { await client.close(); await supervisor.close(); }
});

test('native input rejects invalid UTF-8, versions, generations and truncated requests', async () => {
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const valid = { wireVersion: 1, requestId: 'request', generation: 'test', operation: { kind: 'describe' } };
  try {
    for (const bytes of [Buffer.from([0xff, 10]), Buffer.from('{'),
      Buffer.from(JSON.stringify({ ...valid, wireVersion: 2 }) + '\n'),
      Buffer.from(JSON.stringify({ ...valid, generation: 'foreign' }) + '\n')]) {
      const process = supervisor.spawn({ executable: resolve(`native/.build/${globalThis.process.platform}-${globalThis.process.arch}/debug/SmipBridge`),
        args: ['test'], env: { REPOPROMPT_PCRE2_JIT: 'disabled' }, cwd: '/' });
      const output: Buffer[] = [];
      process.child.stdout.on('data', (data: Buffer) => output.push(data));
      process.child.stdin.end(bytes);
      assert.equal((await process.closed).code, 1);
      assert.equal(Buffer.concat(output).length, 0);
    }
  } finally { await supervisor.close(); }
});

test('base64 framing preserves arbitrary bytes and failed decoding remains a source outcome', async () => {
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const client = new BridgeClient({ executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), supervisor, env: { REPOPROMPT_PCRE2_JIT: 'disabled' } });
  try {
    await fc.assert(fc.asyncProperty(fc.uint8Array(), async data => {
      const bytes = Buffer.from(data);
      const response = await client.request({ kind: 'extract', extension: 'swift', bytes: bytes.toString('base64'),
        expected: { sha256: createHash('sha256').update(bytes).digest('hex'), byteCount: bytes.length },
      }, new AbortController().signal);
      assert.equal(response.result.kind, 'extracted');
      if (response.result.kind !== 'extracted') assert.fail('Missing extraction result');
      const valid = Buffer.from(bytes.toString('utf8')).equals(bytes);
      assert.equal(response.result.outcome.kind === 'decodeFailed', !valid);
    }));
    const response = await client.request({ kind: 'extract', extension: 'txt', bytes: '', expected: { sha256: createHash('sha256').update('').digest('hex'), byteCount: 0 } }, new AbortController().signal);
    assert.equal(response.result.kind, 'unsupportedExtension');
    for (const [text, kind] of [
      ['a'.repeat(5_000_001), 'utf8Bytes'],
      ['a'.repeat(1_500_001), 'utf16Units'],
      ['\n'.repeat(25_000), 'lines'],
    ]) {
      assert(text && kind);
      const bytes = Buffer.from(text);
      const oversized = await client.request({ kind: 'extract', extension: 'swift', bytes: bytes.toString('base64'), expected: { sha256: createHash('sha256').update(bytes).digest('hex'), byteCount: bytes.length } }, new AbortController().signal);
      if (oversized.result.kind !== 'extracted' || oversized.result.outcome.kind !== 'oversize') assert.fail('Missing oversize reason');
      assert.equal(oversized.result.outcome.reason.kind, kind);
    }
  } finally {
    await client.close();
    await supervisor.close();
  }
});

 test('worker retirement attributes active failures once and never attributes an idle crash to completed source', async () => {
  for (const scenario of ['held', 'idleSource']) {
    let owned!: OwnedProcess;
    class Supervisor extends ProcessSupervisor { override spawn(spec: ProcessSpec) { return owned = super.spawn(spec); } }
    const supervisor = new Supervisor({ terminationGraceMs: 20 });
    const client = new BridgeClient({ executable: resolve('test/fixtures/native-worker.mjs'), supervisor, env: { PATH: dirname(process.execPath), SCENARIO: scenario } });
    const expected = { sha256: createHash('sha256').update('').digest('hex'), byteCount: 0 };
    try {
      if (scenario === 'held') {
        const held = new Promise<void>(resolve => owned.child.stderr.once('data', () => resolve()));
        const active = client.request({ kind: 'extract', extension: 'swift', bytes: '', expected }, new AbortController().signal);
        const queued = client.request({ kind: 'describe' }, new AbortController().signal);
        const settled = Promise.allSettled([active, queued]);
        await held; owned.child.stdin.destroy(new Error('write failure'));
        const results = await settled;
        assert(results.every(result => result.status === 'rejected'));
        const first = results[0], second = results[1];
        assert(first?.status === 'rejected' && second?.status === 'rejected');
        assert(first.reason instanceof NativeWorkerFailure);
        assert.strictEqual(first.reason, second.reason);
        assert.deepEqual(first.reason.sourceIdentity, expected);
        assert.deepEqual(first.reason.receipt, await owned.closed);
      } else {
        await client.request({ kind: 'readSource', root: { generation: 'fixture', id: 'fixture' }, path: 'source.swift', expected }, new AbortController().signal);
        owned.child.kill('SIGKILL'); await owned.closed;
        await assert.rejects(client.request({ kind: 'describe' }, new AbortController().signal), error => {
          assert(error instanceof NativeWorkerFailure); assert.equal(error.sourceIdentity, null); return true;
        });
      }
    } finally { await client.close(); await supervisor.close(); }
  }
});
