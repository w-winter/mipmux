import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const range = Type.Object({ start: Type.Integer(), end: Type.Integer(), description: Type.Union([Type.String(), Type.Null()]) });
const casesSchema = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Object({ kind: Type.Literal('renderFileBlock'),
  selectedPath: Type.String(), fileName: Type.String(), content: Type.String(), ranges: Type.Union([Type.Array(range), Type.Null()]),
}), expected: Type.Unknown() })));
const resultSchema = Compile(Type.Object({ result: Type.Unknown() }));
const blockSchema = Compile(Type.Object({ text: Type.String(), combinedText: Type.String(), isFullFile: Type.Boolean(),
  segments: Type.Array(Type.Object({ text: Type.String() })),
  bodySpans: Type.Array(Type.Object({ offset: Type.Integer(), length: Type.Integer() })) }));

test('native file blocks preserve original full/slice formatting, normalized ranges and line endings', async () => {
  const cases = casesSchema.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-file-blocks/cases.json'), 'utf8')));
  const proof = [];
  for (const entry of cases) {
    const generation = 'file-blocks';
    const result = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, requestId: entry.name, generation, operation: entry.input }) + '\n', encoding: 'utf8',
    });
    assert.equal(result.status, 0, entry.name + ': ' + result.stderr);
    const found = resultSchema.Parse(JSON.parse(result.stdout.trim())).result;
    const block = blockSchema.Parse(found);
    const { bodySpans, ...formatted } = block;
    assert.deepEqual(formatted, entry.expected, entry.name);
    const bodies = block.isFullFile ? [block.combinedText] : block.segments.map(segment => segment.text);
    assert.equal(bodySpans.length, bodies.length, entry.name);
    const bytes = Buffer.from(block.text);
    for (const [index, span] of bodySpans.entries()) {
      assert(bytes.subarray(span.offset, span.offset + span.length).equals(Buffer.from(bodies[index]!)), entry.name);
    }
    proof.push({ name: entry.name, result: found });
  }
  await writeFile(resolve('test-output/reference-file-block-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
