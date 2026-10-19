import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeOperation, type NativeResult } from '../src/contracts/native.js';

const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(),
  input: NativeOperation, expected: Type.Record(Type.String(), Type.Unknown()) })));

test('native questions preserve RPCE parsing, form schemas and structured answers', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-ask-user/cases.json', 'utf8')));
  const proof: { name: string; result: NativeResult }[] = [];
  for (const entry of cases) {
    const generation = 'ask-user-reference';
    const frame = callNative(entry.input, generation, entry.name);
    assert.equal(frame.kind, 'terminal'); assert(frame.kind === 'terminal');
    const actual = frame.result;
    assert.deepEqual(actual, entry.expected, entry.name);
    proof.push({ name: entry.name, result: actual });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-ask-user-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
