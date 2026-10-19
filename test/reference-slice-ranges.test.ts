import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeSliceRange, NativeSliceRangesInput } from '../src/contracts/native.js';
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: NativeSliceRangesInput, expected: Type.Array(NativeSliceRange) })));
const reply = Compile(Type.Object({ result: Type.Object({ kind: Type.Literal('sliceRanges'), ranges: Type.Array(NativeSliceRange) }) }));

test('native slice math preserves source normalization, descriptions and subtraction fragments', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-slice-ranges/cases.json'), 'utf8')));
  const proof: unknown[] = [];
  for (const entry of cases) {
    const generation = 'slice-reference';
    const nativeFrame = callNative(entry.input, generation, entry.name);
    const ranges = reply.Parse(nativeFrame).result.ranges;
    assert.deepEqual(ranges, entry.expected, entry.name);
    proof.push({ name: entry.name, ranges });
  }
  await writeFile(resolve('test-output/reference-slice-ranges-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
