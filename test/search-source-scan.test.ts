import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MipmuxRuntime } from '../src/runtime/mipmux-runtime.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation, NativeSearchSourceOutcome } from '../src/contracts/native.js';
import { searchValidator } from '../src/contracts/exploration.js';
import { serializedBytes } from '../src/exploration/output-budget.js';

/** A search's mode and query, and optionally its result limit; `searchValidator.Default` fills in the rest. */
interface SearchInput {
  readonly mode: 'path' | 'content'; readonly query: { readonly kind: 'glob' | 'literal'; readonly text: string }; readonly maxResults?: number;
}

const signal = () => new AbortController().signal;
/** Whether new bridges record their requests, and a hook run before each recorded request is sent. */
interface Recording { recording: boolean; beforeRequest: (operation: NativeOperation) => Promise<void> }
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

/**
 * A warm workspace, with `extra` files written under its root, whose bridges started while `recording` is set, the search's
 * own, record every native request kind.
 */
async function fixture(extra: Readonly<Record<string, string>> = {}) {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-search-source-scan-'));
  const root = join(base, 'root'), outputRoot = join(base, 'out');
  await mkdir(root); await mkdir(outputRoot);
  await writeFile(join(root, 'Main.swift'), 'let needle = 1\n');
  // A NUL in the first 8 KiB makes RPCE's search treat a file as binary, even when its bytes are valid UTF-8 ...
  await writeFile(join(root, 'blob.dat'), 'needle\0\0binary payload\n');
  // ... unless its extension is always text.
  await writeFile(join(root, 'notes.md'), 'needle\0 in markdown\n');
  await writeFile(join(root, 'image.png'), Buffer.concat([pngSignature, Buffer.from('needle\n')]));
  for (const name of ['a', 'b', 'c']) await writeFile(join(root, `page-${name}.dat`), 'pager\n');
  await mkdir(join(root, 'gone'));
  await writeFile(join(root, 'kept.txt'), 'vanishing\n'); await writeFile(join(root, 'gone', 'victim.txt'), 'vanishing\n');
  for (const [name, text] of Object.entries(extra)) await writeFile(join(root, name), text);
  const requests: string[] = [];
  const state: Recording = { recording: false, beforeRequest: async () => {} };
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000,
    credentialPaths: [], nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } };
  class Runtime extends MipmuxRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        readonly #recorded = state.recording;
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (this.#recorded) { requests.push(operation.kind); await state.beforeRequest(operation); }
          return super.request(operation, requestSignal);
        }
        override async scanSources(operation: Extract<NativeOperation, { kind: 'scanSearchSources' }>, requestSignal: AbortSignal,
          consume: (outcome: NativeSearchSourceOutcome) => void) {
          if (this.#recorded) { requests.push(operation.kind); await state.beforeRequest(operation); }
          return super.scanSources(operation, requestSignal, consume);
        }
      }
      return new Bridge({ executable: options.nativeExecutable, env: options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime(options);
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot }, signal());
  await workspace.refresh(signal());
  const search = async (input: SearchInput) => {
    const operation = await workspace.openOperation(signal());
    try {
      state.recording = true;
      const found = await operation.fileSearch(searchValidator.Parse(searchValidator.Default({ maxOutputBytes: 100000, ...input })));
      if (found.kind !== 'search') assert.fail('Missing search result');
      return found;
    } finally { state.recording = false; await operation.close(); }
  };
  return { root, runtime, workspace, state, search, requests };
}

test('a path-only search reads no file contents', async () => {
  const { runtime, search, requests } = await fixture();
  try {
    const found = await search({ mode: 'path', query: { kind: 'glob', text: '*.swift' } });
    assert.deepEqual(found.files.map(file => file.path), ['Main.swift']);
    assert.deepEqual(requests.filter(kind => kind === 'readSource' || kind === 'scanSearchSources'), []);
  } finally { await runtime.close(); }
});

test('a content search skips RPCE-binary files without reporting them, and searches always-text files', async () => {
  const { runtime, search } = await fixture();
  try {
    const found = await search({ mode: 'content', query: { kind: 'literal', text: 'needle' } });
    assert.deepEqual(found.files.map(file => file.path).sort(), ['Main.swift', 'notes.md']);
    assert.deepEqual(found.limitations, []);
  } finally { await runtime.close(); }
});

test('a content continuation rejects a file that became binary after its first page', async () => {
  const { root, runtime, workspace } = await fixture();
  try {
    const operation = await workspace.openOperation(signal());
    try {
      const query = searchValidator.Parse(searchValidator.Default({ mode: 'content', query: { kind: 'literal', text: 'pager' }, maxOutputBytes: 100000 }));
      const full = await operation.fileSearch(query);
      if (full.kind !== 'search') assert.fail('Missing search result');
      assert.deepEqual(full.files.map(file => file.path), ['page-a.dat', 'page-b.dat', 'page-c.dat']);
      const cap = serializedBytes({ ...full, files: full.files.slice(0, 1), returnedMatchingLines: 1,
        truncated: true, continuation: { digest: '0'.repeat(64), offset: 1 } });
      const first = await operation.fileSearch({ ...query, maxOutputBytes: cap });
      if (first.kind !== 'search' || !first.continuation) assert.fail('Missing continuation');
      await writeFile(join(root, 'page-a.dat'), 'pager\0\n');
      await assert.rejects(operation.fileSearch({ ...query, maxOutputBytes: cap, continuation: first.continuation }), { code: 'sourceChanged' });
    } finally { await operation.close(); }
  } finally { await runtime.close(); }
});

test('a first page uses the policy its refresh captured, and a continuation revalidates it', async () => {
  const { root, runtime, workspace, requests, state } = await fixture();
  try {
    const operation = await workspace.openOperation(signal());
    try {
      const query = searchValidator.Parse(searchValidator.Default({ mode: 'path', query: { kind: 'glob', text: 'page-*' }, maxOutputBytes: 100000 }));
      const full = await operation.fileSearch(query);
      if (full.kind !== 'search') assert.fail('Missing search result');
      const cap = serializedBytes({ ...full, files: full.files.slice(0, 1), truncated: true, continuation: { digest: '0'.repeat(64), offset: 1 } });
      state.recording = true;
      const first = await operation.fileSearch({ ...query, maxOutputBytes: cap });
      state.recording = false;
      if (first.kind !== 'search' || !first.continuation) assert.fail('Missing continuation');
      assert.deepEqual(requests.filter(kind => kind === 'queryIgnoreHierarchy' || kind === 'captureIgnoreInputs'), []);
      await writeFile(join(root, '.gitignore'), 'page-b.dat\n');
      await assert.rejects(operation.fileSearch({ ...query, maxOutputBytes: cap, continuation: first.continuation }), { code: 'policyChanged' });
    } finally { await operation.close(); }
  } finally { await runtime.close(); }
});

test('a directory removed during a search limits only the files beneath it', async () => {
  const { root, runtime, state, search } = await fixture();
  try {
    state.beforeRequest = async operation => {
      if (operation.kind === 'scanSearchSources') await rm(join(root, 'gone'), { recursive: true });
    };
    const found = await search({ mode: 'content', query: { kind: 'literal', text: 'vanishing' } });
    assert.deepEqual(found.files.map(file => file.path), ['kept.txt']);
    assert.deepEqual(found.limitations, [{ root: 'r', path: 'gone/victim.txt', code: 'notFound' }]);
  } finally { await runtime.close(); }
});

test('the result limit carries across files that are read in separate batches', async () => {
  // Each file is larger than half of a scan batch, so each is read in its own batch.
  const filler = 'x'.repeat(79) + '\n';
  const large = (matches: number) => 'limited\n'.repeat(matches) + filler.repeat(64 * 1024);
  const { runtime, search } = await fixture({ 'large-a.txt': large(3), 'large-b.txt': large(3), 'large-c.txt': large(3) });
  try {
    const found = await search({ mode: 'content', query: { kind: 'literal', text: 'limited' }, maxResults: 4 });
    assert.deepEqual(found.files.map(file => [file.path, file.matchingLines]), [['large-a.txt', 3], ['large-b.txt', 1]]);
    assert.equal(found.counts.matchingLines, 4);
  } finally { await runtime.close(); }
});
