import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Unknown(), expected: Type.Unknown() })));
const reply = Compile(Type.Object({ result: Type.Unknown() }));

test('native reference token components match the original source aggregate and omitted zero fields', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-token-stats/cases.json', 'utf8')));
  const proof: { name: string; result: unknown }[] = [];
  for (const fixture of cases) {
    const generation = 'token-stats-reference';
    const child = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, requestId: fixture.name, generation, operation: fixture.input }) + '\n', encoding: 'utf8',
    });
    assert.equal(child.status, 0, fixture.name + ': ' + child.stderr);
    const actual = reply.Parse(JSON.parse(child.stdout.trim())).result;
    assert.deepEqual(actual, fixture.expected, fixture.name);
    proof.push({ name: fixture.name, result: actual });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-token-stats-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
