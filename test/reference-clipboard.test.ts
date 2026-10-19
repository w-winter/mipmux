import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeClipboardInput } from '../src/contracts/native.js';

const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: NativeClipboardInput.properties.input,
  expected: Type.Object({ kind: Type.Literal('clipboard'), text: Type.String(), utf8Bytes: Type.Integer(), sha256: Type.String() }),
})));
const reply = Compile(Type.Object({ result: Type.Unknown() }));

test('native clipboard packaging preserves original map, content, Git, meta and user sections', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-clipboard/cases.json', 'utf8')));
  const proof: { name: string; bytes: number }[] = [];
  for (const fixture of cases) {
    const generation = 'clipboard';
    const nativeFrame = callNative({ kind: 'renderClipboard', input: fixture.input }, generation, fixture.name);
    assert.deepEqual(reply.Parse(nativeFrame).result,
      { kind: 'clipboard', text: fixture.expected.text }, fixture.name);
    assert.equal(Buffer.byteLength(fixture.expected.text), fixture.expected.utf8Bytes, fixture.name);
    proof.push({ name: fixture.name, bytes: fixture.expected.utf8Bytes });
  }
  await writeFile('test-output/reference-clipboard-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
