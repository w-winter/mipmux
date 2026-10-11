import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Object({ kind: Type.Literal('parseGitPatch'), text: Type.String() }), expected: Type.Unknown() })));
const envelope = Compile(Type.Object({ result: Type.Unknown() }));
test('native patch splitting, hunks, counts and changed-line text preserve original RPCE outputs', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-patch/cases.json', 'utf8')));
  const proof: unknown[] = [];
  for (const entry of cases) {
    const generation = 'git-patch-reference';
    const child = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, generation, requestId: entry.name, operation: entry.input }) + '\n', encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    const result = envelope.Parse(JSON.parse(child.stdout.trim())).result;
    assert.deepEqual(result, entry.expected, entry.name);
    proof.push({ name: entry.name, result });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-git-patch-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
