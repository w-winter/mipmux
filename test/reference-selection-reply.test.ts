import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const fields = { path: Type.String(), rootPath: Type.String(), pathWithinRoot: Type.String(), tokens: Type.Integer() };
const entry = Type.Union([
  Type.Object({ ...fields, kind: Type.Literal('full') }),
  Type.Object({ ...fields, kind: Type.Literal('slice'), ranges: Type.Array(Type.Object({ start: Type.Integer(), end: Type.Integer(),
    description: Type.Union([Type.String(), Type.Null()]) })) }),
  Type.Object({ ...fields, kind: Type.Literal('codemap'), origin: Type.Enum(['auto', 'manual']) }),
]);
const casesSchema = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Object({ kind: Type.Literal('renderSelectionReply'),
  entries: Type.Array(entry), status: Type.String(), codemapAutoEnabled: Type.Boolean(), invalidPaths: Type.Array(Type.String()),
  unmappedPaths: Type.Array(Type.String()), blocks: Type.Union([Type.Array(Type.String()), Type.Null()]), view: Type.String(),
}), expected: Type.Unknown() })));
const reply = Compile(Type.Object({ result: Type.Object({ kind: Type.Literal('selectionReply'), reply: Type.Unknown() }) }));

test('native selection replies preserve original DTOs, category order, summaries and codemap view filtering', async () => {
  const cases = casesSchema.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-selection-reply/cases.json'), 'utf8')));
  const proof = [];
  for (const entry of cases) {
    const generation = 'selection-reply';
    const result = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, requestId: entry.name, generation, operation: entry.input }) + '\n', encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const found = reply.Parse(JSON.parse(result.stdout.trim())).result.reply;
    assert.deepEqual(found, entry.expected, entry.name);
    proof.push({ name: entry.name, result: found });
  }
  await writeFile(resolve('test-output/reference-selection-reply-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
