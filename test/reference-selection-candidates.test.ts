import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { NativeSelectionCandidatesInput, NativeSelectionCandidatesResult } from '../src/contracts/native.js';
import { Compile } from 'typebox/compile';

const resolution = Type.Omit(NativeSelectionCandidatesResult, ['kind']);
const casesSchema = Compile(Type.Array(Type.Object({ name: Type.String(), input: NativeSelectionCandidatesInput, expected: resolution })));
const reply = Compile(Type.Object({ result: NativeSelectionCandidatesResult }));

test('native selection candidates preserve source input order, folder expansion, diagnostics and extension eligibility', async () => {
  const cases = casesSchema.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-selection-candidates/cases.json'), 'utf8')));
  const proof: unknown[] = [];
  for (const entry of cases) {
    const generation = 'selection-candidates';
    const result = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, requestId: entry.name, generation, operation: entry.input }) + '\n', encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const frames = result.stdout.trim().split('\n'); assert.equal(frames.length, 1);
    const { kind, ...found } = reply.Parse(JSON.parse(frames[0]!)).result;
    assert.equal(kind, 'selectionCandidates');
    assert.deepEqual(found, entry.expected, entry.name);
    proof.push({ name: entry.name, result: found });
  }
  await writeFile(resolve('test-output/reference-selection-candidates-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
