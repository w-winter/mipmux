import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeSelectionReplyInput } from '../src/contracts/native.js';

const casesSchema = Compile(Type.Array(Type.Object({ name: Type.String(), input: NativeSelectionReplyInput, expected: Type.Unknown() })));
const reply = Compile(Type.Object({ result: Type.Object({ kind: Type.Literal('selectionReply'), reply: Type.Unknown() }) }));

test('native selection replies preserve original DTOs, category order, summaries and codemap view filtering', async () => {
  const cases = casesSchema.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-selection-reply/cases.json'), 'utf8')));
  const proof = [];
  for (const entry of cases) {
    const generation = 'selection-reply';
    const nativeFrame = callNative(entry.input, generation, entry.name);
    const found = reply.Parse(nativeFrame).result.reply;
    assert.deepEqual(found, entry.expected, entry.name);
    proof.push({ name: entry.name, result: found });
  }
  await writeFile(resolve('test-output/reference-selection-reply-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
