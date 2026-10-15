import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { resolveAutomaticRoot } from '../src/workspace/automatic-root-query.js';
import { automaticRootCases, automaticRootInput } from './fixtures/automatic-root-cases.js';

const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), expected: Type.Unknown() })));

test('automatic root query counting and remaining budgets match original Swift execution', async () => {
  const reference = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-automatic-budget/cases.json', 'utf8')));
  assert.equal(reference.length, automaticRootCases.length);
  for (const entry of automaticRootCases) {
    const expected = reference.find(item => item.name === entry.name); assert(expected);
    const result = resolveAutomaticRoot(automaticRootInput(entry));
    const observed = result.kind === 'ready' ? { ...result, targets: result.targets.map(file => file.path) } : result;
    assert.deepEqual(observed, expected.expected, entry.name);
  }
});
