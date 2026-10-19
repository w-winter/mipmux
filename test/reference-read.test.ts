import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeReadTextInput, NativeReadTextResult } from '../src/contracts/native.js';

const readFixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: NativeReadTextInput, expected: NativeReadTextResult })));
const reply = Compile(Type.Object({ result: NativeReadTextResult }));

test('native read bounds match original source preparation, parser priority, tail and error results', async () => {
  const cases = readFixtures.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-read/cases.json'), 'utf8')));
  const proof: unknown[] = [];
  for (const entry of cases) {
    const generation = 'reference-read';
    const nativeFrame = callNative(entry.input, generation, entry.name);
    const found = reply.Parse(nativeFrame);
    assert.deepEqual(found.result, entry.expected, entry.name);
    proof.push({ name: entry.name, result: found.result });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile(resolve('test-output/reference-read-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
