import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeSelectionState, NativeSelectionTransitionInput } from '../src/contracts/native.js';

const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: NativeSelectionTransitionInput, expected: NativeSelectionState })));
const reply = Compile(Type.Object({ kind: Type.Literal('terminal'), result: Type.Object({
  kind: Type.Literal('selectionTransition'), selection: NativeSelectionState,
}) }));

test('native pre-resolved selection transitions retain source representation, ordering and automatic-mode effects', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-selection-transitions/cases.json'), 'utf8')));
  const proof: { name: string; selection: unknown }[] = [];
  for (const entry of cases) {
    const generation = 'selection-reference';
    const nativeFrame = callNative(entry.input, generation, entry.name);
    const selected = reply.Parse(nativeFrame).result.selection;
    // RPCE turns automatic codemaps off for codemap-only edits; mipmux keeps the input's mode, which only clearing codemaps changes.
    assert.deepEqual(selected, { ...entry.expected, codemapAutoEnabled: entry.input.selection.codemapAutoEnabled }, entry.name);
    proof.push({ name: entry.name, selection: selected });
  }
  await writeFile(resolve('test-output/reference-selection-transitions-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
