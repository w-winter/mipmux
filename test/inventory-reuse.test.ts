import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MipmuxRuntime } from '../src/runtime/mipmux-runtime.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import type { InventorySnapshot } from '../src/contracts/inventory.js';

const signal = () => new AbortController().signal;
const nativeExecutable = resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`);

/** Declares the fixture workspace in a runtime over `base`'s cache whose bridges record source reads and request kinds. */
async function start(base: string, settings: { nativeExecutable?: string; codeMapsGloballyDisabled?: boolean } = {}) {
  const reads: string[] = [], kinds: string[] = [];
  const options = { copyContext: { ...copyContext(), codeMapsGloballyDisabled: settings.codeMapsGloballyDisabled ?? false },
    cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: settings.nativeExecutable ?? nativeExecutable, nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } };
  class Runtime extends MipmuxRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          kinds.push(operation.kind);
          if (operation.kind === 'readSource') reads.push(operation.path);
          return super.request(operation, requestSignal);
        }
      }
      return new Bridge({ executable: options.nativeExecutable, env: options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime(options);
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(base, 'root') }], exclusions: [],
    outputRoot: join(base, 'out') }, signal());
  return { runtime, workspace, reads, kinds };
}

/** A refreshed workspace over two top-level files and a subdirectory of three. */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-inventory-reuse-'));
  const root = join(base, 'root');
  await mkdir(join(root, 'sub'), { recursive: true }); await mkdir(join(base, 'out'));
  await writeFile(join(root, 'Model.swift'), 'struct Model { let value: Int }\n');
  await writeFile(join(root, 'Other.swift'), 'struct Other { let value: Int }\n');
  for (const name of ['a', 'b', 'c']) await writeFile(join(root, 'sub', name + '.swift'), `struct ${name.toUpperCase()} {}\n`);
  const started = await start(base);
  await started.workspace.refresh(signal());
  return { base, root, ...started };
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

test('a refresh sends one ignore query per listed directory besides the root admission', async () => {
  const { runtime, workspace, kinds } = await fixture();
  try {
    kinds.length = 0;
    await workspace.refresh(signal());
    const count = (kind: string) => kinds.filter(entry => entry === kind).length;
    assert.equal(count('queryIgnoreHierarchy'), count('listDirectory') + 1);
  } finally { await runtime.close(); }
});

test('a restarted runtime rereads only files changed while it was stopped', async () => {
  const { base, root, runtime, workspace } = await fixture();
  const before = await workspace.refresh(signal());
  await runtime.close();
  await writeFile(join(root, 'Other.swift'), 'struct Other { let value: Int; let more: Int }\n');
  const restarted = await start(base);
  try {
    const after = await restarted.workspace.refresh(signal());
    assert.deepEqual(restarted.reads, ['Other.swift']);
    assert.deepEqual(file(after, 'Model.swift'), file(before, 'Model.swift'));
  } finally { await restarted.runtime.close(); }
});

test('a saved record is not reused after the native executable or the codemap setting changes', async () => {
  for (const change of ['executable', 'codemaps'] as const) {
    const { base, runtime } = await fixture();
    await runtime.close();
    const wrapper = join(base, 'wrapped-bridge');
    await writeFile(wrapper, `#!/bin/sh\nexec '${nativeExecutable}' "$@"\n`); await chmod(wrapper, 0o755);
    const restarted = await start(base, change === 'executable' ? { nativeExecutable: wrapper } : { codeMapsGloballyDisabled: true });
    try {
      const snapshot = await restarted.workspace.refresh(signal());
      const files = snapshot.entries.filter(entry => entry.kind === 'file').map(entry => entry.path);
      assert.deepEqual(new Set(restarted.reads), new Set(files), change);
      if (change === 'codemaps') assert.equal(file(snapshot, 'Model.swift').structural.kind, 'pending');
    } finally { await restarted.runtime.close(); }
  }
});

test('a corrupt saved record fails the scan until it is invalidated', async () => {
  const { base, runtime, workspace } = await fixture();
  const key = (await workspace.refresh(signal())).workspaceKey;
  await runtime.close();
  await writeFile(join(base, 'cache/v1/workspaces', key, 'reuse.json'), '{}');
  const restarted = await start(base);
  try {
    await assert.rejects(restarted.workspace.refresh(signal()), { code: 'cacheCorrupt', details: { target: { kind: 'reuse', key } } });
    await restarted.runtime.artifacts.invalidateReuse(key);
    await restarted.workspace.refresh(signal());
  } finally { await restarted.runtime.close(); }
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
