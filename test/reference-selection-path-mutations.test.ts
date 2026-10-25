import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { NativeSelectionPathMutationInput, NativeSelectionPathMutationResult } from '../src/contracts/native.js';
import { Compile } from 'typebox/compile';

const reply = Compile(Type.Object({ result: NativeSelectionPathMutationResult }));
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: NativeSelectionPathMutationInput, expected: NativeSelectionPathMutationResult })));

test('ordinary source path mutations preserve slices, manual membership, promotion, demotion and diagnostic state', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-selection-path-mutations/cases.json'), 'utf8')));
  const proof: unknown[] = [];
  for (const entry of cases) {
    const generation = 'ordinary-path-selection';
    const nativeFrame = callNative(entry.input, generation, entry.name);
    const found = reply.Parse(nativeFrame);
    // RPCE turns automatic codemaps off for codemap-only edits; mipmux keeps the input's mode, which only clearing codemaps changes.
    assert.deepEqual(found.result, { ...entry.expected,
      selection: { ...entry.expected.selection, codemapAutoEnabled: entry.input.selection.codemapAutoEnabled } }, entry.name);
    proof.push({ name: entry.name, result: found.result });
  }
  await writeFile(resolve('test-output/reference-selection-path-mutations-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
