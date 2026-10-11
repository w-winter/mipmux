import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
const query = Type.Union([
  Type.Object({ op: Type.Literal('log'), count: Type.Integer(), path: Type.Union([Type.String(), Type.Null()]) }),
  Type.Object({ op: Type.Literal('blame'), path: Type.String(), lines: Type.Union([Type.String(), Type.Null()]) }),
  Type.Object({ op: Type.Literal('status') }),
]);
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), query, stdout: Type.String(),
  expectedArguments: Type.Array(Type.String()), expected: Type.Unknown() })));
const envelope = Compile(Type.Object({ result: Type.Unknown() }));
test('native Git status, log and blame preserve source command arguments, parsing and public DTO fields', async () => {
  const cases = [...fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-read/cases.json', 'utf8'))),
    ...fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-status/cases.json', 'utf8')))];
  const proof: unknown[] = [];
  for (const entry of cases) {
    const argumentsWithSecurityBinding = entry.query.op === 'blame'
      ? [entry.expectedArguments[0], '--no-textconv', ...entry.expectedArguments.slice(1)] : entry.expectedArguments;
    for (const [operation, expected] of [
      [{ kind: 'prepareGitRead', query: entry.query }, { kind: 'gitReadArguments', args: argumentsWithSecurityBinding }],
      [{ kind: 'projectGitRead', query: entry.query, bytes: Buffer.from(entry.stdout).toString('base64') }, entry.expected],
    ]) {
      const generation = 'git-read';
      const child = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
        input: JSON.stringify({ wireVersion: 1, generation, requestId: entry.name, operation }) + '\n', encoding: 'utf8',
      });
      assert.equal(child.status, 0, child.stderr);
      const found = envelope.Parse(JSON.parse(child.stdout.trim())).result;
      assert.deepEqual(found, expected, entry.name);
      proof.push({ name: entry.name, operation, result: found });
    }
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-git-read-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
