import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MipmuxRuntime } from '../src/runtime/mipmux-runtime.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import type { InventorySnapshot } from '../src/contracts/inventory.js';

const signal = () => new AbortController().signal;

/** A runtime whose bridges record the path of every source read. */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-inventory-reuse-'));
  const root = join(base, 'root'), outputRoot = join(base, 'out');
  await mkdir(root); await mkdir(outputRoot);
  await writeFile(join(root, 'Model.swift'), 'struct Model { let value: Int }\n');
  await writeFile(join(root, 'Other.swift'), 'struct Other { let value: Int }\n');
  const reads: string[] = [];
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000,
    credentialPaths: [], nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } };
  class Runtime extends MipmuxRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (operation.kind === 'readSource') reads.push(operation.path);
          return super.request(operation, requestSignal);
        }
      }
      return new Bridge({ executable: options.nativeExecutable, env: options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime(options);
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot }, signal());
  await workspace.refresh(signal());
  return { root, runtime, workspace, reads };
}

function file(snapshot: InventorySnapshot, path: string) {
  const entry = snapshot.entries.find(entry => entry.path === path);
  assert(entry?.kind === 'file', path);
  return entry;
}

test('a refresh reads only files whose descriptor fingerprint changed', async () => {
  const { root, runtime, workspace, reads } = await fixture();
  try {
    reads.length = 0;
    const unchanged = await workspace.refresh(signal());
    assert.deepEqual(reads, []);
    await writeFile(join(root, 'Other.swift'), 'struct Other { let value: Int; let more: Int }\n');
    const edited = await workspace.refresh(signal());
    assert.deepEqual(reads, ['Other.swift']);
    assert.notDeepEqual(file(edited, 'Other.swift').identity, file(unchanged, 'Other.swift').identity);
    assert.deepEqual(file(edited, 'Model.swift'), file(unchanged, 'Model.swift'));
  } finally { await runtime.close(); }
});

test('a same-size edit with its modification time restored, or a replacement by rename, is read again', async () => {
  const { root, runtime, workspace } = await fixture();
  try {
    const path = join(root, 'Model.swift'), before = await stat(path);
    const original = file(await workspace.refresh(signal()), 'Model.swift');
    await writeFile(path, 'struct Model { let other: Int }\n');
    await utimes(path, before.atime, before.mtime);
    const restored = file(await workspace.refresh(signal()), 'Model.swift');
    assert.notDeepEqual(restored.identity, original.identity);
    await writeFile(join(root, 'replacement.tmp'), 'struct Model { let third: Int }\n');
    await utimes(join(root, 'replacement.tmp'), before.atime, before.mtime);
    await rename(join(root, 'replacement.tmp'), path);
    const replaced = file(await workspace.refresh(signal()), 'Model.swift');
    assert.notDeepEqual(replaced.identity, restored.identity);
  } finally { await runtime.close(); }
});

test('a reused file whose codemap record was invalidated has its record rebuilt', async () => {
  const { runtime, workspace, reads } = await fixture();
  try {
    const structural = file(await workspace.refresh(signal()), 'Model.swift').structural;
    assert(structural.kind === 'artifact');
    await runtime.artifacts.invalidate(structural.key.digest);
    reads.length = 0;
    const rebuilt = file(await workspace.refresh(signal()), 'Model.swift').structural;
    assert(rebuilt.kind === 'artifact');
    assert.deepEqual(rebuilt.record, structural.record);
    assert.deepEqual(reads, ['Model.swift']);
  } finally { await runtime.close(); }
});
