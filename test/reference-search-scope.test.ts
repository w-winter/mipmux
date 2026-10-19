import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeOperation } from '../src/contracts/native.js';

const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: NativeOperation, expected: Type.Unknown() })));
const reply = Compile(Type.Object({ result: Type.Unknown() }));

test('native search scope clauses match the original index filter', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-search-scope/cases.json', 'utf8')));
  const proof: { name: string; result: unknown }[] = [];
  for (const fixture of cases) {
    const generation = 'search-scope-reference';
    const nativeFrame = callNative(fixture.input, generation, fixture.name);
    const actual = reply.Parse(nativeFrame).result;
    assert.deepEqual(actual, fixture.expected, fixture.name);
    proof.push({ name: fixture.name, result: actual });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-search-scope-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
