import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Unknown(),
  expected: Type.Object({ kind: Type.Literal('promptAssembly'), text: Type.String() }),
})));
const reply = Compile(Type.Object({ result: Type.Unknown() }));

test('native prompt assembly preserves original section order, inclusion and newline behavior', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-prompt-assembly/cases.json'), 'utf8')));
  const proof: { name: string; bytes: number }[] = [];
  for (const fixture of cases) {
    const generation = 'prompt-assembly';
    const result = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, requestId: fixture.name, generation, operation: fixture.input }) + '\n', encoding: 'utf8',
    });
    assert.equal(result.status, 0, fixture.name + ': ' + result.stderr);
    assert.deepEqual(reply.Parse(JSON.parse(result.stdout.trim())).result, fixture.expected, fixture.name);
    proof.push({ name: fixture.name, bytes: Buffer.byteLength(fixture.expected.text) });
  }
  await writeFile(resolve('test-output/reference-prompt-assembly-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
