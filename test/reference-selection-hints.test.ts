import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const casesSchema = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Object({
  kind: Type.Literal('selectionHint'), paths: Type.Array(Type.String()), operation: Type.String(),
  roots: Type.Array(Type.Object({ name: Type.String(), path: Type.String() })),
}), expected: Type.String() })));
const reply = Compile(Type.Object({ result: Type.Object({ kind: Type.Literal('selectionHint'), message: Type.String() }) }));

test('native selection hints match the original root order, absolute boundary and sampled path diagnostics', async () => {
  const cases = casesSchema.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-selection-hints/cases.json'), 'utf8')));
  const proof = [];
  for (const entry of cases) {
    const generation = 'selection-hints';
    const result = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, requestId: entry.name, generation, operation: entry.input }) + '\n', encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const found = reply.Parse(JSON.parse(result.stdout.trim())).result;
    assert.equal(found.message, entry.expected, entry.name);
    proof.push({ name: entry.name, result: found });
  }
  await writeFile(resolve('test-output/reference-selection-hints-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
