import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
    const result = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, requestId: entry.name, generation, operation: entry.input }) + '\n', encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const frames = result.stdout.trim().split('\n'); assert.equal(frames.length, 1);
    const found = reply.Parse(JSON.parse(frames[0]!));
    assert.deepEqual(found.result, entry.expected, entry.name);
    proof.push({ name: entry.name, result: found.result });
  }
  await writeFile(resolve('test-output/reference-selection-path-mutations-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
