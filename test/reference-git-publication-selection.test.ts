import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeSelectionState, type NativeOperation } from '../src/contracts/native.js';

const request = Type.Object({ kind: Type.Literal('transitionSelection'), selection: NativeSelectionState,
  mutation: Type.Object({ kind: Type.Literal('gitPublication'), contextSelection: NativeSelectionState }) });
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: request, expected: NativeSelectionState,
  afterRemoval: Type.Union([Type.Null(), Type.Object({ paths: Type.Array(Type.String()), expected: NativeSelectionState })]) })));
const response = Compile(Type.Object({ kind: Type.Literal('terminal'), result: Type.Object({
  kind: Type.Literal('selectionTransition'), selection: NativeSelectionState }) }));

test('native Git publication selection merge preserves original captured/latest state and latent codemap membership', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-publication-selection/cases.json', 'utf8')));
  const invoke = (operation: NativeOperation) => {
    const generation = 'git-selection-reference';
    const result = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, requestId: 'merge', generation, operation }) + '\n', encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const frames = result.stdout.trim().split('\n'); assert.equal(frames.length, 1);
    return response.Parse(JSON.parse(frames[0]!)).result.selection;
  };
  const proof: { name: string; selection: ReturnType<typeof invoke>; removed: ReturnType<typeof invoke> | null }[] = [];
  for (const entry of cases) {
    const selection = invoke(entry.input); assert.deepEqual(selection, entry.expected, entry.name);
    const removed = entry.afterRemoval === null ? null : invoke({ kind: 'transitionSelection', selection,
      mutation: { kind: 'fullFiles', op: 'remove', paths: entry.afterRemoval.paths } });
    if (entry.afterRemoval !== null) assert.deepEqual(removed, entry.afterRemoval.expected, entry.name + ': remove full');
    proof.push({ name: entry.name, selection, removed });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-git-publication-selection-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
