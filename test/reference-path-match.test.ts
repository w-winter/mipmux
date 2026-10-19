import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativePathMatchInput } from '../src/contracts/native.js';
const match = Type.Union([Type.Object({ rootPath: Type.String(), correctedPath: Type.String() }), Type.Null()]);
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: NativePathMatchInput, expected: match })));
const reply = Compile(Type.Object({ result: Type.Object({ kind: Type.Literal('pathMatch'), match }) }));

test('native mcpSelection path matching preserves original source exact, alias, fuzzy and Unicode behavior', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-path-match/cases.json'), 'utf8')));
  const proof: unknown[] = [];
  for (const entry of cases) {
    const generation = 'path-reference';
    const nativeFrame = callNative(entry.input, generation, entry.name);
    const found = reply.Parse(nativeFrame).result.match;
    assert.deepEqual(found, entry.expected, entry.name);
    proof.push({ name: entry.name, match: found });
  }
  await writeFile(resolve('test-output/reference-path-match-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});

test('native path-match catalog rejects parent traversal instead of returning an escaped relative match', () => {
  const generation = 'path-boundary';
  const result = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
    input: JSON.stringify({ wireVersion: 1, requestId: 'escape', generation, operation: { kind: 'matchSelectionPath',
      query: 'escape.swift', roots: [{ name: 'Project', path: '/reference/project', files: ['../escape.swift'], directories: [] }] } }) + '\n', encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'Malformed captured metadata must fail at the native boundary');
  assert(result.stderr.includes('nativeProtocolError'));
});
