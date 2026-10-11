import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeResult, type NativeOperation } from '../src/contracts/native.js';
const input = Type.Union([
  Type.Object({ kind: Type.Literal('parseGitComparison'), raw: Type.Union([Type.String(), Type.Null()]) }),
  Type.Object({ kind: Type.Literal('projectGitDiff'), compare: Type.String(), detail: Type.String(), pathspecCount: Type.Integer(),
    isMultiRepo: Type.Boolean(), changedFiles: Type.Array(Type.Object({ path: Type.String(), status: Type.String(),
      additions: Type.Union([Type.Integer(), Type.Null()]), deletions: Type.Union([Type.Integer(), Type.Null()]) })),
    perFilePatches: Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]) }),
]);
type ProjectionInput = Extract<NativeOperation, { kind: 'parseGitComparison' | 'projectGitDiff' }>;
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input, expected: Type.Unknown() })));
const envelope = Compile(Type.Object({ result: NativeResult }));
test('native comparison parsing and diff DTO/truncation preserve original RPCE outputs', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-diff/cases.json', 'utf8')));
  const proof: unknown[] = [];
  const call = (operation: ProjectionInput) => {
    const generation = 'git-diff-reference';
    const child = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, generation, requestId: 'diff', operation }) + '\n', encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    return envelope.Parse(JSON.parse(child.stdout.trim())).result;
  };
  for (const entry of cases) {
    const found = call(entry.input);
    assert.deepEqual(found, entry.expected, entry.name);
    proof.push({ name: entry.name, result: found });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-git-diff-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
