import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
    const result = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, requestId: entry.name, generation, operation: entry.input }) + '\n', encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const frames = result.stdout.trim().split('\n'); assert.equal(frames.length, 1);
    const selected = reply.Parse(JSON.parse(frames[0]!)).result.selection;
    assert.deepEqual(selected, entry.expected, entry.name);
    proof.push({ name: entry.name, selection: selected });
  }
  await writeFile(resolve('test-output/reference-selection-transitions-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
