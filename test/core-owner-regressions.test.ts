import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const signal = () => new AbortController().signal;
async function fixture() {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-core-owner-'));
  const root = join(base, 'root'), outputRoot = join(base, 'out');
  await mkdir(root); await mkdir(outputRoot);
  await writeFile(join(root, 'model.swift'), 'struct Model {\n let value: String\n}');
  return { base, root, spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot },
    options: { cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
      nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
      nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } } };
}

test('refresh observers settle on their publication while a later scan remains held', async () => {
  const { spec, options } = await fixture();
  const entered = barrier(), resume = barrier(), firstEntered = barrier(), firstResume = barrier();
  let lists = 0, firstPublished = false;
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (operation.kind === 'listDirectory') {
            lists++;
            if (lists === 2) { firstEntered.release(); await firstResume.promise; }
            if (lists === 3) { entered.release(); await resume.promise; await this.close(); }
          }
          return super.request(operation, requestSignal);
        }
      }
      return new Bridge({ executable: options.nativeExecutable, env: options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime(options);
  try {
    const handle = await runtime.declare(spec, signal());
    const first = handle.refresh(signal()).then(snapshot => { firstPublished = true; return snapshot; });
    void first.catch(() => {});
    // The warm scan publishes generation 1; refresh 2 must not wait for refresh 3.
    await firstEntered.promise;
    const second = handle.refresh(signal()); firstResume.release();
    void second.catch(() => {});
    await entered.promise;
    await setImmediate();
    assert.equal(firstPublished, true);
    resume.release();
    const a = await first;
    assert.equal(a.generation, 2);
    await assert.rejects(second, /nativeWorkerClosed/);
    assert.equal((await handle.refresh(signal())).enumeration.kind, 'complete');
    await handle.close();
  } finally { firstResume.release(); resume.release(); await runtime.close(); }
});

test('explicit refresh replaces a retired generation without rebinding a replaced root', async () => {
  for (const replace of [false, true]) {
    const { root, spec, options } = await fixture();
    const bridges: BridgeClient[] = [];
    let retireNextList = false;
    class Runtime extends SmipRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
            if (retireNextList && operation.kind === 'listDirectory') { retireNextList = false; await this.close(); }
            return super.request(operation, requestSignal);
          }
        }
        const bridge = new Bridge({ executable: options.nativeExecutable, env: options.nativeEnvironment, supervisor: this.supervisor });
        bridges.push(bridge);
        return bridge;
      }
    }
    const runtime = new Runtime(options);
    try {
      const handle = await runtime.declare(spec, signal());
      await handle.refresh(signal());
      retireNextList = true;
      await assert.rejects(handle.refresh(signal()), /nativeWorkerClosed/);
      if (replace) {
        await rename(root, root + '-original'); await mkdir(root);
        await writeFile(join(root, 'model.swift'), 'replacement');
        await assert.rejects(handle.refresh(signal()), /rootChanged/);
      } else {
        const recovered = await handle.refresh(signal());
        assert.equal(recovered.enumeration.kind, 'complete');
        assert(recovered.entries.some(entry => entry.kind === 'file'));
        const idle = bridges.at(-1);
        if (!idle) assert.fail('missing recovered worker');
        await idle.close();
        assert.equal((await handle.refresh(signal())).enumeration.kind, 'complete');
      }
      await handle.close();
    } finally { await runtime.close(); }
  }
});

test('closing a shared extraction consumer does not join the producer', async () => {
  const { base, spec, options } = await fixture();
  await mkdir(join(base, 'out-b'));
  const entered = barrier(), resume = barrier(), secondRead = barrier(), consumerClosed = barrier();
  let reads = 0, extractions = 0;
  class Runtime extends SmipRuntime {
    override makeBridge() {
      let consumer = false;
      class Bridge extends BridgeClient {
        override async close() { await super.close(); if (consumer) consumerClosed.release(); }
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (operation.kind === 'extract') { extractions++; entered.release(); await resume.promise; }
          const result = await super.request(operation, requestSignal);
          if (operation.kind === 'readSource' && operation.path === 'model.swift' && ++reads === 2) {
            consumer = true; secondRead.release();
          }
          return result;
        }
      }
      return new Bridge({ executable: options.nativeExecutable, env: options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime(options);
  try {
    const a = await runtime.declare(spec, signal()); await entered.promise;
    const b = await runtime.declare({ ...spec, outputRoot: join(base, 'out-b') }, signal()); await secondRead.promise;
    let closed = false;
    const closing = b.close().then(() => { closed = true; });
    await consumerClosed.promise; await setImmediate();
    assert.equal(closed, true, 'consumer close must not wait for held extraction');
    resume.release(); await closing;
    await a.refresh(signal()); assert.equal(extractions, 1);
    await a.close();
  } finally { resume.release(); await runtime.close(); }
});

test('runtime shutdown reaches an extraction producer retained by a client workspace', async () => {
  const { base, spec, options } = await fixture();
  await mkdir(join(base, 'out-b'));
  const entered = barrier(), aborted = barrier(), resume = barrier(), secondRead = barrier();
  let reads = 0;
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (operation.kind === 'extract') {
            entered.release();
            requestSignal.addEventListener('abort', aborted.release, { once: true });
            await resume.promise;
          }
          const result = await super.request(operation, requestSignal);
          if (operation.kind === 'readSource' && operation.path === 'model.swift' && ++reads === 2) secondRead.release();
          return result;
        }
      }
      return new Bridge({ executable: options.nativeExecutable, env: options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime(options);
  const client = runtime.createClient(null);
  const a = await client.declare(spec, signal()); await entered.promise;
  await client.declare({ ...spec, outputRoot: join(base, 'out-b') }, signal()); await secondRead.promise;
  const observer = assert.rejects(client.refresh(a.id, signal()), /workspaceClosed|cancelled/);
  const closing = runtime.close();
  let reached = false; void aborted.promise.then(() => { reached = true; });
  await setImmediate();
  try { assert.equal(reached, true, 'shutdown must reach the producer before joining clients'); }
  finally { resume.release(); await observer; await closing; }
});
