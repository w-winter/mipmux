import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { NativeOperation } from '../src/contracts/native.js';
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
    const operations: [NativeOperation, unknown][] = [
      [{ kind: 'prepareGitRead', query: entry.query }, { kind: 'gitReadArguments', args: argumentsWithSecurityBinding }],
      [{ kind: 'projectGitRead', query: entry.query, bytes: Buffer.from(entry.stdout).toString('base64') }, entry.expected],
    ];
    for (const [operation, expected] of operations) {
      const generation = 'git-read';
      const nativeFrame = callNative(operation, generation, entry.name);
      const found = envelope.Parse(nativeFrame).result;
      assert.deepEqual(found, expected, entry.name);
      proof.push({ name: entry.name, operation, result: found });
    }
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-git-read-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
