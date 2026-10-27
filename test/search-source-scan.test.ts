import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MipmuxRuntime } from '../src/runtime/mipmux-runtime.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { searchValidator } from '../src/contracts/exploration.js';

interface SearchInput { readonly mode: 'path' | 'content'; readonly query: { readonly kind: 'glob' | 'literal'; readonly text: string } }

const signal = () => new AbortController().signal;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

/** A warm workspace whose bridges started while `recording` is set, the search's own, record every native request kind. */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-search-source-scan-'));
  const root = join(base, 'root'), outputRoot = join(base, 'out');
  await mkdir(root); await mkdir(outputRoot);
  await writeFile(join(root, 'Main.swift'), 'let needle = 1\n');
  // A NUL in the first 8 KiB makes RPCE's search treat a file as binary, even when its bytes are valid UTF-8 ...
  await writeFile(join(root, 'blob.dat'), 'needle\0\0binary payload\n');
  // ... unless its extension is always text.
  await writeFile(join(root, 'notes.md'), 'needle\0 in markdown\n');
  await writeFile(join(root, 'image.png'), Buffer.concat([pngSignature, Buffer.from('needle\n')]));
  const requests: string[] = [];
  const state = { recording: false };
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000,
    credentialPaths: [], nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } };
  class Runtime extends MipmuxRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        readonly #recorded = state.recording;
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (this.#recorded) requests.push(operation.kind);
          return super.request(operation, requestSignal);
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
  return { runtime, search, requests };
}

test('a path-only search reads no file contents', async () => {
  const { runtime, search, requests } = await fixture();
  try {
    const found = await search({ mode: 'path', query: { kind: 'glob', text: '*.swift' } });
    assert.deepEqual(found.files.map(file => file.path), ['Main.swift']);
    assert.deepEqual(requests.filter(kind => kind === 'readSource'), []);
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
