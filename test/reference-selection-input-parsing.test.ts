import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { NativeSelectionInputParsingRequest, NativeSelectionInputParsingResult } from '../src/contracts/native.js';
import { Compile } from 'typebox/compile';
const reply = Compile(Type.Object({ result: NativeSelectionInputParsingResult }));
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: NativeSelectionInputParsingRequest, expected: NativeSelectionInputParsingResult })));

test('selection input parser retains source hash-range recognition, coercion, descriptions and invalid-token diagnostics', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-selection-input-parsing/cases.json'), 'utf8')));
  const proof: unknown[] = [];
  for (const entry of cases) {
    const generation = 'selection-parse';
    const result = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, requestId: entry.name, generation, operation: entry.input }) + '\n', encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const frames = result.stdout.trim().split('\n'); assert.equal(frames.length, 1);
    const found = reply.Parse(JSON.parse(frames[0]!));
    assert.deepEqual(found.result, entry.expected, entry.name);
    proof.push({ name: entry.name, result: found.result });
  }
  await writeFile(resolve('test-output/reference-selection-input-parsing-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
