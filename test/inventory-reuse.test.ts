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
import { failureResult } from '../src/runtime/tool-result.js';

const signal = () => new AbortController().signal;
const nativeExecutable = resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`);
// A scan reads a file again when its status-change time was within this margin of the previous read.
const reuseMarginMs = 2000;

interface Settings { readonly nativeExecutable?: string; readonly codeMapsGloballyDisabled?: boolean;
  /** Holds the response to the first read of this file for this long. */
  readonly slowRead?: { readonly path: string; readonly ms: number } }

/** Declares the fixture workspace in a runtime over `base`'s cache whose bridges record source reads and request kinds. */
async function start(base: string, settings: Settings = {}) {
  const reads: string[] = [], kinds: string[] = [];
  let slow = settings.slowRead;
  const options = { copyContext: { ...copyContext(), codeMapsGloballyDisabled: settings.codeMapsGloballyDisabled ?? false },
    cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: settings.nativeExecutable ?? nativeExecutable, nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } };
  class Runtime extends MipmuxRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          kinds.push(operation.kind);
          if (operation.kind === 'readSource') reads.push(operation.path);
          const reply = await super.request(operation, requestSignal);
          if (operation.kind === 'readSource' && slow && operation.path === slow.path) {
            const { ms } = slow; slow = undefined;
            await new Promise(resolve => setTimeout(resolve, ms));
          }
          return reply;
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

/** A refreshed workspace over two top-level files and a subdirectory of three; `settled` files predate the reuse margin. */
async function fixture({ settled = false, settings = {} }: { readonly settled?: boolean; readonly settings?: Settings } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-inventory-reuse-'));
  const root = join(base, 'root');
  await mkdir(join(root, 'sub'), { recursive: true }); await mkdir(join(base, 'out'));
  await writeFile(join(root, 'Model.swift'), 'struct Model { let value: Int }\n');
  await writeFile(join(root, 'Other.swift'), 'struct Other { let value: Int }\n');
  for (const name of ['a', 'b', 'c']) await writeFile(join(root, 'sub', name + '.swift'), `struct ${name.toUpperCase()} {}\n`);
  if (settled) await new Promise(resolve => setTimeout(resolve, reuseMarginMs + 100));
  const started = await start(base, settings);
  await started.workspace.refresh(signal());
  return { base, root, ...started };
}

function file(snapshot: InventorySnapshot, path: string) {
  const entry = snapshot.entries.find(entry => entry.path === path);
  assert(entry?.kind === 'file', path);
  return entry;
}

test('a refresh reads only files whose descriptor fingerprint changed', async () => {
  const { root, runtime, workspace, reads } = await fixture({ settled: true });
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

test('a reusable file edited at the same size with its modification time restored, or replaced by rename, is read again', async () => {
  const { root, runtime, workspace, reads } = await fixture({ settled: true });
  try {
    const original = await workspace.refresh(signal());
    const model = join(root, 'Model.swift'), other = join(root, 'Other.swift');
    const modelTimes = await stat(model), otherTimes = await stat(other);
    await writeFile(model, 'struct Model { let other: Int }\n');
    await utimes(model, modelTimes.atime, modelTimes.mtime);
    await writeFile(join(root, 'replacement.tmp'), 'struct Other { let third: Int }\n');
    await utimes(join(root, 'replacement.tmp'), otherTimes.atime, otherTimes.mtime);
    await rename(join(root, 'replacement.tmp'), other);
    reads.length = 0;
    const edited = await workspace.refresh(signal());
    assert.deepEqual(reads.sort(), ['Model.swift', 'Other.swift']);
    assert.notDeepEqual(file(edited, 'Model.swift').identity, file(original, 'Model.swift').identity);
    assert.notDeepEqual(file(edited, 'Other.swift').identity, file(original, 'Other.swift').identity);
  } finally { await runtime.close(); }
});

test('a refresh sends one native request per listed directory besides the root policy capture and admission', async () => {
  const { runtime, workspace, kinds } = await fixture();
  try {
    kinds.length = 0;
    await workspace.refresh(signal());
    const count = (kind: string) => kinds.filter(entry => entry === kind).length;
    // The fixture lists two directories: the root and `sub`.
    assert.deepEqual(['captureIgnoreInputs', 'queryIgnoreHierarchy', 'listDirectory', 'walkDirectory'].map(count), [1, 1, 0, 2]);
  } finally { await runtime.close(); }
});

test('a read that completes after the reuse margin still counts from its start', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-inventory-reuse-'));
  await mkdir(join(base, 'root')); await mkdir(join(base, 'out'));
  await writeFile(join(base, 'root', 'Model.swift'), 'struct Model { let value: Int }\n');
  const { runtime, workspace, reads } = await start(base, { slowRead: { path: 'Model.swift', ms: reuseMarginMs + 100 } });
  try {
    // The slow read cannot be recorded, so a later scan reads the file again; by then it has settled and is recorded.
    await workspace.refresh(signal());
    await workspace.refresh(signal());
    assert.deepEqual(reads, ['Model.swift', 'Model.swift']);
  } finally { await runtime.close(); }
});

test('a file changed within the reuse margin of its read is read again by the next refresh', async () => {
  const { root, runtime, workspace, reads } = await fixture({ settled: true });
  try {
    await writeFile(join(root, 'Other.swift'), 'struct Other { let value: Int; let more: Int }\n');
    await workspace.refresh(signal());
    reads.length = 0;
    await workspace.refresh(signal());
    assert.deepEqual(reads, ['Other.swift']);
  } finally { await runtime.close(); }
});

test('a restarted runtime rereads only files changed while it was stopped', async () => {
  const { base, root, runtime, workspace } = await fixture({ settled: true });
  const before = await workspace.refresh(signal());
  await runtime.close();
  await writeFile(join(root, 'Other.swift'), 'struct Other { let value: Int; let more: Int }\n');
  const restarted = await start(base);
  try {
    const after = await restarted.workspace.refresh(signal());
    assert.deepEqual([...new Set(restarted.reads)], ['Other.swift']);
    assert.deepEqual(file(after, 'Model.swift'), file(before, 'Model.swift'));
  } finally { await restarted.runtime.close(); }
});

/** Writes an executable script at `path` that runs the native bridge, replacing any earlier one by rename. */
async function writeWrapper(path: string, comment: string) {
  await writeFile(path + '.tmp', `#!/bin/sh\n# ${comment}\nexec '${nativeExecutable}' "$@"\n`); await chmod(path + '.tmp', 0o755);
  await rename(path + '.tmp', path);
}

test('a saved record is reused only while the native executable and the codemap setting are unchanged', async () => {
  for (const change of ['none', 'executable', 'codemaps'] as const) {
    const { base, runtime } = await fixture({ settled: true });
    await runtime.close();
    const wrapper = join(base, 'wrapped-bridge');
    await writeWrapper(wrapper, 'wrapped');
    const restarted = await start(base, change === 'executable' ? { nativeExecutable: wrapper }
      : change === 'codemaps' ? { codeMapsGloballyDisabled: true } : {});
    try {
      const snapshot = await restarted.workspace.refresh(signal());
      const files = snapshot.entries.filter(entry => entry.kind === 'file').map(entry => entry.path);
      assert.deepEqual(new Set(restarted.reads), new Set(change === 'none' ? [] : files), change);
      if (change === 'codemaps') assert.equal(file(snapshot, 'Model.swift').structural.kind, 'pending');
    } finally { await restarted.runtime.close(); }
  }
});

test('a saved record names the executable its helper started from, not one that replaced it later', async () => {
  const wrapper = join(await mkdtemp(join(tmpdir(), 'mipmux-inventory-wrapper-')), 'wrapped-bridge');
  await writeWrapper(wrapper, 'first');
  const { base, runtime, workspace } = await fixture({ settled: true, settings: { nativeExecutable: wrapper } });
  // The running helper was started from the first script; only helpers started later use the second.
  await writeWrapper(wrapper, 'second');
  await workspace.refresh(signal());
  await runtime.close();
  const restarted = await start(base, { nativeExecutable: wrapper });
  try {
    const snapshot = await restarted.workspace.refresh(signal());
    const files = snapshot.entries.filter(entry => entry.kind === 'file').map(entry => entry.path);
    assert.deepEqual(new Set(restarted.reads), new Set(files));
  } finally { await restarted.runtime.close(); }
});

test('a corrupt saved record fails the scan until it is invalidated', async () => {
  const { base, runtime, workspace } = await fixture();
  const key = (await workspace.refresh(signal())).workspaceKey;
  await runtime.close();
  await writeFile(join(base, 'cache/v1/workspaces', key, 'reuse.json'), '{}');
  const restarted = await start(base);
  try {
    const failure: unknown = await restarted.workspace.refresh(signal()).then(() => assert.fail('The scan read a corrupt record'), error => error);
    assert.deepEqual(failureResult(failure), { kind: 'error', code: 'cacheCorrupt', target: { kind: 'reuse', key } });
    await restarted.runtime.artifacts.invalidateReuse(key);
    await restarted.workspace.refresh(signal());
  } finally { await restarted.runtime.close(); }
});

test('a reused file whose codemap record was invalidated has its record rebuilt', async () => {
  const { runtime, workspace, reads } = await fixture({ settled: true });
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
