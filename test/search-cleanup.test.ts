import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import type { ProcessSpec } from '../src/runtime/process-supervisor.js';

test('search scratch cleanup handles success, query failure, cancellation and partial writes while preserving siblings', async t => {
  await fs.mkdir('test-output', { recursive: true });
  const base = await fs.mkdtemp(join(tmpdir(), 'smip-search-cleanup-'));
  const root = join(base, 'root'), out = join(base, 'out'), cache = join(base, 'cache');
  await fs.mkdir(root); await fs.mkdir(out); await fs.writeFile(join(root, 'file.txt'), 'needle\n');
  const runtime = new SmipRuntime({ cachePath: cache, terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    search: { executable: process.env.SMIP_TEST_RG ?? resolve('.smip-work/test-ripgrep/ripgrep-e89fff89ac9af12e8d4ce9d5fd07beb408ca730f/target/release/rg') } });
  const work = join(cache, 'v1/work'), sibling = join(work, 'sibling');
  try {
    const handle = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, new AbortController().signal);
    await fs.mkdir(sibling, { recursive: true }); await fs.writeFile(join(sibling, 'keep'), 'retained');
    for (const scenario of ['success', 'error', 'cancel', 'partial']) {
      const abort = new AbortController(), operation = await handle.openOperation(abort.signal);
      const spawn = runtime.supervisor.spawn.bind(runtime.supervisor), write = fs.writeFile;
      let childClosed = false, scratchAtClose = false;
      if (scenario === 'cancel') t.mock.method(runtime.supervisor, 'spawn', (spec: ProcessSpec) => {
        const owned = spawn(spec);
        if (spec.args.includes('--json')) {
          void owned.closed.then(() => { childClosed = true; scratchAtClose = readdirSync(work).some(name => name.startsWith('search-')); });
          abort.abort();
        }
        return owned;
      });
      if (scenario === 'partial') {
        t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
          if (typeof args[0] === 'string' && args[0].startsWith(work + '/search-')) {
            await write(args[0], 'partial', args[2]); throw new Error('partial write failure');
          }
          return write(...args);
        });
        syncBuiltinESMExports();
      }
      try {
        const pending = operation.fileSearch({ mode: 'content', query: { kind: 'regex', text: scenario === 'error' ? '[' : 'needle', caseSensitive: true, wholeWord: false },
          filters: { roots: [], directories: [], include: [], exclude: [], extensions: [] }, before: 0, after: 0, countOnly: false, maxResults: 50, maxOutputBytes: 10000, continuation: null });
        if (scenario === 'success') assert.equal((await pending).kind, 'search');
        else await assert.rejects(pending);
        if (scenario === 'cancel') { assert.equal(childClosed, true); assert.equal(scratchAtClose, true); }
        assert.deepEqual(await fs.readdir(work), ['sibling']);
        assert.equal(await fs.readFile(join(sibling, 'keep'), 'utf8'), 'retained');
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await operation.close(); }
    }
    await handle.close();
  } finally { await runtime.close(); }
});
