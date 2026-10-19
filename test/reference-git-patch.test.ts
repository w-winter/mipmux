import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Object({ kind: Type.Literal('parseGitPatch'), text: Type.String() }), expected: Type.Unknown() })));
const envelope = Compile(Type.Object({ result: Type.Unknown() }));
test('native patch splitting, hunks, counts and changed-line text preserve original RPCE outputs', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-patch/cases.json', 'utf8')));
  const proof: unknown[] = [];
  for (const entry of cases) {
    const generation = 'git-patch-reference';
    const nativeFrame = callNative(entry.input, generation, entry.name);
    const result = envelope.Parse(nativeFrame).result;
    assert.deepEqual(result, entry.expected, entry.name);
    proof.push({ name: entry.name, result });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-git-patch-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
