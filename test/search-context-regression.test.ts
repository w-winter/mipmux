import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';

test('dense overlapping context emits each source line once with linear selection work', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-search-context-'));
  await mkdir(join(base, 'root')); await mkdir(join(base, 'out'));
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    search: { executable: process.env.SMIP_TEST_RG ?? resolve('.smip-work/test-ripgrep/ripgrep-e89fff89ac9af12e8d4ce9d5fd07beb408ca730f/target/release/rg') } });
  const measurements: { lines: number; numericSetInsertions: number; durationMs: number }[] = [];
  try {
    const handle = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(base, 'root') }], exclusions: [], outputRoot: join(base, 'out') }, new AbortController().signal);
    for (const count of [256, 512, 1024]) {
      await writeFile(join(base, 'root/dense.txt'), 'needle\r\n'.repeat(count - 1) + 'needle');
      await handle.refresh(new AbortController().signal);
      const operation = await handle.openOperation(new AbortController().signal);
      const add = Set.prototype.add;
      let numericSetInsertions = 0;
      Set.prototype.add = new Proxy(add, { apply(target, receiver, args) {
        if (typeof args[0] === 'number') numericSetInsertions++;
        return Reflect.apply(target, receiver, args);
      } });
      const started = performance.now();
      try {
        const result = await operation.fileSearch({ mode: 'content', query: { kind: 'literal', text: 'needle', caseSensitive: true, wholeWord: false },
          filters: { roots: [], directories: [], include: [], exclude: [], extensions: [] }, before: count, after: count,
          countOnly: false, maxOutputBytes: 1000000, continuation: null });
        if (result.kind !== 'search') assert.fail('Missing search result');
        assert.equal(result.counts.matchingLines, count);
        assert.deepEqual(result.files[0]?.lines, Array.from({ length: count }, (_, index) => ({
          number: index + 1, text: index === count - 1 ? 'needle' : 'needle\r\n', matching: true } )));
        measurements.push({ lines: count, numericSetInsertions, durationMs: performance.now() - started });
      } finally { Set.prototype.add = add; await operation.close(); }
    }
    await writeFile(join(base, 'scaling.json'), JSON.stringify(measurements));
    console.log(JSON.stringify({ artifact: join(base, 'scaling.json'), measurements }));
    // Matching and expansion each need at most one set insertion per source line.
    assert(measurements.every(item => item.numericSetInsertions <= item.lines * 2));
    await handle.close();
  } finally { await runtime.close(); }
});
