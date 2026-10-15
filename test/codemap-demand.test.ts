import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';

async function fixture(outcome: 'held' | 'failFirst' = 'held') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'smip-codemap-demand-')));
  const root = join(base, 'source'), output = join(base, 'out');
  await mkdir(join(root, 'private'), { recursive: true }); await mkdir(output);
  await writeFile(join(root, '.repo_ignore'), 'private/\n');
  await writeFile(join(root, 'private/Hidden.swift'), 'struct Hidden { let value: Int }\n');
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let extractions = 0;
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (operation.kind === 'extract') {
            extractions++; entered(); await held;
            if (outcome === 'failFirst' && extractions === 1) throw new Error('Fixture extraction failed');
          }
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const owner = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, new AbortController().signal);
  await owner.refresh(new AbortController().signal);
  return { base, runtime, owner, entering, release, source: { root: 'r', path: 'private/Hidden.swift' }, extractions: () => extractions };
}

test('workspace codemap demand shares extraction and releasing one request preserves another retainer', async () => {
  const f = await fixture();
  const first = await f.owner.openOperation(new AbortController().signal);
  const second = await f.owner.openOperation(new AbortController().signal);
  try {
    const one = await first.requestExplicitCodemap(f.source);
    const entering = Promise.race([f.entering, one.result.then(() => { throw new Error('Demand settled before extraction'); })]);
    await entering;
    const two = await second.requestExplicitCodemap(f.source);
    await one.release(); await first.close();
    assert.equal(f.extractions(), 1);
    f.release();
    const result = await two.result;
    assert.equal(result.structural.kind, 'artifact');
    if (result.structural.kind === 'artifact') assert.equal(result.structural.record.outcome.kind, 'ready');
    await two.release();
    await writeFile(join(f.base, 'shared-demand-receipt.json'), JSON.stringify({ extractions: f.extractions(), result }, null, 2) + '\n');
  } finally { f.release(); await first.close(); await second.close(); await f.owner.close(); await f.runtime.close(); }
});

test('last codemap retain release joins admitted extraction and a later request can use the durable artifact', async () => {
  const f = await fixture();
  const operation = await f.owner.openOperation(new AbortController().signal);
  try {
    const lease = await operation.requestExplicitCodemap(f.source);
    await Promise.race([f.entering, lease.result.then(() => { throw new Error('Demand settled before extraction'); })]);
    const rejected = assert.rejects(lease.result, /cancelled|aborted/i);
    let joined = false;
    const closing = lease.release().then(() => { joined = true; });
    await Promise.resolve(); assert.equal(joined, false);
    f.release(); await closing; await rejected;
    const registered = operation.snapshot.entries.find(entry => entry.root === f.source.root && entry.path === f.source.path);
    assert(registered?.kind === 'file'); assert.equal(registered.structural.kind, 'pending');
    const retry = await operation.requestExplicitCodemap(f.source);
    const result = await retry.result; await retry.release();
    assert.equal(result.structural.kind, 'artifact'); assert.equal(f.extractions(), 1);
    await writeFile(join(f.base, 'released-demand-receipt.json'), JSON.stringify({ registered, result, extractions: f.extractions() }, null, 2) + '\n');
  } finally { f.release(); await operation.close(); await f.owner.close(); await f.runtime.close(); }
});

test('failed native codemap demand releases its flight and a later request retries the same source', async () => {
  const f = await fixture('failFirst');
  const operation = await f.owner.openOperation(new AbortController().signal);
  try {
    const failed = await operation.requestExplicitCodemap(f.source);
    const rejected = assert.rejects(failed.result, /Fixture extraction failed/);
    f.release(); await rejected; await failed.release();
    const retry = await operation.requestExplicitCodemap(f.source);
    const result = await retry.result; await retry.release();
    assert.equal(result.structural.kind, 'artifact'); assert.equal(f.extractions(), 2);
    await writeFile(join(f.base, 'failed-demand-receipt.json'), JSON.stringify({ result, extractions: f.extractions() }, null, 2) + '\n');
  } finally { f.release(); await operation.close(); await f.owner.close(); await f.runtime.close(); }
});

test('source changes during extraction cannot publish a ready codemap into the managed catalog', async () => {
  await mkdir('test-output', { recursive: true });
  const f = await fixture();
  const operation = await f.owner.openOperation(new AbortController().signal);
  try {
    const lease = await operation.requestExplicitCodemap(f.source);
    await Promise.race([f.entering, lease.result.then(() => { throw new Error('Demand settled before extraction'); })]);
    await writeFile(join(f.base, 'source', f.source.path), 'struct Replaced { let title: String }\n');
    const rejected = assert.rejects(lease.result, /sourceChanged/);
    f.release(); await rejected; await lease.release();
    const registered = operation.snapshot.entries.find(entry => entry.root === f.source.root && entry.path === f.source.path);
    assert(registered?.kind === 'file'); assert.equal(registered.structural.kind, 'pending');
    await writeFile('test-output/stale-demand-proof.json', JSON.stringify({ registered, extractions: f.extractions() }, null, 2) + '\n');
  } finally { f.release(); await operation.close(); await f.owner.close(); await f.runtime.close(); }
});

test('runtime shutdown cancels and joins owned codemap demand before completing', async () => {
  const f = await fixture();
  const operation = await f.owner.openOperation(new AbortController().signal);
  try {
    const lease = await operation.requestExplicitCodemap(f.source);
    await Promise.race([f.entering, lease.result.then(() => { throw new Error('Demand settled before extraction'); })]);
    const rejected = assert.rejects(lease.result, /cancelled|aborted|nativeWorkerClosed/i);
    let joined = false;
    const closing = f.runtime.close().then(() => { joined = true; });
    await Promise.resolve(); assert.equal(joined, false);
    f.release(); await closing; await rejected; await lease.release();
    await writeFile(join(f.base, 'shutdown-demand-receipt.json'), JSON.stringify({ joined, extractions: f.extractions() }, null, 2) + '\n');
  } finally { f.release(); await operation.close(); await f.owner.close(); await f.runtime.close(); }
});
