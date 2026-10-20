import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { ArtifactStore } from '../src/workspace/artifact-store.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import { sha256 } from '../src/workspace/values.js';

test('artifact publication agrees across owners; corruption is diagnosed and explicitly invalidated', async () => {
  await mkdir('test-output', { recursive: true });
  const cache = await mkdtemp(resolve('test-output/cache-'));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const native = new BridgeClient({ executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), supervisor,
    env: { REPOPROMPT_PCRE2_JIT: 'disabled' } });
  try {
    const bytes = Buffer.from('struct CacheRecord {\n let value: String\n}');
    const reply = await native.request({ kind: 'extract', extension: 'swift', bytes: bytes.toString('base64'),
      expected: { sha256: sha256(bytes), byteCount: bytes.length } }, new AbortController().signal);
    if (reply.result.kind !== 'extracted') assert.fail('Missing artifact');
    const a = new ArtifactStore(cache), b = new ArtifactStore(cache);
    const writers = [0, 1].map(() => supervisor.spawn({ executable: process.execPath,
      args: [resolve('test/fixtures/cache-writer.mjs')], env: {}, cwd: resolve('.') }));
    await Promise.all(writers.map(writer => new Promise<void>(resolve => writer.child.stdout.once('data', () => resolve()))));
    for (const writer of writers) writer.child.stdin.end(JSON.stringify({ cache, result: reply.result }));
    const receipts = await Promise.all(writers.map(writer => writer.closed));
    assert(receipts.every(receipt => receipt.code === 0));
    await Promise.all([a.insert(reply.result), b.insert(reply.result)]);
    await assert.rejects(a.insert({ ...reply.result, outcome: { kind: 'readyNoSymbols' }, projection: null }), /cacheConflict/);
    assert.deepEqual(await a.read(reply.result.key), await b.read(reply.result.key));
    const path = join(cache, 'v1/artifacts', reply.result.key.digest.slice(0, 2), reply.result.key.digest + '.json');
    await writeFile(path, '{}');
    await assert.rejects(a.read(reply.result.key), /cacheCorrupt/);
    await a.invalidate(reply.result.key.digest);
    assert.equal(await a.read(reply.result.key), null);
  } finally { await native.close(); await supervisor.close(); }
});
