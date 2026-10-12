import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Unknown(),
  expected: Type.Object({ kind: Type.Literal('clipboard'), text: Type.String(), utf8Bytes: Type.Integer(), sha256: Type.String() }),
})));
const reply = Compile(Type.Object({ result: Type.Unknown() }));

test('native clipboard packaging preserves original map, content, Git, meta and user sections', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-clipboard/cases.json', 'utf8')));
  const proof: { name: string; bytes: number }[] = [];
  for (const fixture of cases) {
    const generation = 'clipboard';
    const child = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, requestId: fixture.name, generation,
        operation: { kind: 'renderClipboard', input: fixture.input } }) + '\n', encoding: 'utf8',
    });
    assert.equal(child.status, 0, fixture.name + ': ' + child.stderr);
    assert.deepEqual(reply.Parse(JSON.parse(child.stdout.trim())).result,
      { kind: 'clipboard', text: fixture.expected.text }, fixture.name);
    assert.equal(Buffer.byteLength(fixture.expected.text), fixture.expected.utf8Bytes, fixture.name);
    proof.push({ name: fixture.name, bytes: fixture.expected.utf8Bytes });
  }
  await writeFile('test-output/reference-clipboard-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
