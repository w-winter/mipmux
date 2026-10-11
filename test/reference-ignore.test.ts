import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeResult, type NativeOperation } from '../src/contracts/native.js';
const nullableText = Type.Union([Type.String(), Type.Null()]);
const input = Type.Object({ kind: Type.Literal('queryIgnoreRules'),
  policy: Type.Union([Type.Object({ kind: Type.Literal('git'), prefix: Type.String() }), Type.Object({ kind: Type.Literal('nonGit') })]),
  controls: Type.Object({ gitignore: nullableText, global: Type.String(), repoIgnore: nullableText, cursorignore: nullableText,
    respectRepoIgnore: Type.Boolean(), respectCursorignore: Type.Boolean() }),
  layers: Type.Array(Type.Object({ content: Type.String(), directory: Type.String(), authority: Type.Enum(['mandatoryGit', 'secondary']) })),
  queries: Type.Array(Type.Object({ path: Type.String(), isDirectory: Type.Boolean() })) });
type IgnoreInput = Extract<NativeOperation, { kind: 'queryIgnoreRules' }>;
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input, expected: Type.Unknown() })));
const envelope = Compile(Type.Object({ result: NativeResult }));
test('native ignore snapshots preserve source mandatory floor, layered matching and negation traversal', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-ignore/cases.json', 'utf8')));
  const proof: unknown[] = [];
  const call = (operation: IgnoreInput) => {
    const generation = 'ignore-reference';
    const child = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, generation, requestId: 'ignore', operation }) + '\n', encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    return envelope.Parse(JSON.parse(child.stdout.trim())).result;
  };
  for (const entry of cases) {
    const result = call(entry.input);
    assert.deepEqual(result, entry.expected, entry.name);
    proof.push({ name: entry.name, result });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-ignore-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
