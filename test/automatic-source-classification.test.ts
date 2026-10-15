import assert from 'node:assert/strict';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { StructureIndex, type StructureFile } from '../src/workspace/structure-index.js';
import { structuralFile, structuralRoots } from './fixtures/structural-inventory.js';

function sourceFile(root: string, path: string, state: 'empty' | 'pending' | 'unsupported' | 'terminal'): StructureFile {
  const file = structuralFile(root, path, [], []);
  assert(file.structural.kind === 'artifact');
  if (state === 'pending') return { ...file, structural: { kind: 'pending', key: file.structural.key } };
  if (state === 'unsupported') return { ...file, structural: { kind: 'unsupported' } };
  const record = structuredClone(file.structural.record);
  delete record.projection;
  record.outcome = state === 'empty' ? { kind: 'readyNoSymbols' } : { kind: 'parseFailed', failure: 'parserReturnedNilTree' };
  return { ...file, structural: { ...file.structural, record } };
}

const schema = Compile(Type.Object({ coverage: Type.Object({ status: Type.Enum(['ok', 'partial', 'pending', 'unavailable']),
  sourceIssues: Type.Array(Type.Object({ source: Type.Object({ root: Type.String(), path: Type.String() }),
    kind: Type.Enum(['sourcePending', 'sourceNotIndexed', 'sourceExcluded']), disposition: Type.Enum(['pending', 'unmapped']) })) }) }));

function observedCoverage(result: ReturnType<typeof schema.Parse>) {
  return { status: result.coverage.status, sourceIssues: result.coverage.sourceIssues.map(issue => ({
    source: issue.source, kind: issue.kind, disposition: issue.disposition,
  })) };
}

test('automatic source classification preserves source aggregate coverage and file diagnostics', () => {
  for (const state of ['empty', 'pending', 'unsupported', 'terminal'] as const) {
    const seed = sourceFile('r', state === 'unsupported' ? 'Seed.txt' : 'Seed.swift', state);
    const observed = schema.Parse(new StructureIndex({ roots: structuralRoots('r'), entries: [seed] }).resolveAutomaticCodemapTargets([seed]));
    const sourceIssues = state === 'pending' ? [{ source: { root: 'r', path: seed.path }, kind: 'sourcePending', disposition: 'pending' }]
      : state === 'unsupported' ? [{ source: { root: 'r', path: seed.path }, kind: 'sourceNotIndexed', disposition: 'unmapped' }] : [];
    assert.deepEqual(observedCoverage(observed), { status: state === 'empty' || state === 'terminal' ? 'ok' : 'pending', sourceIssues }, state);
  }
  const pending = sourceFile('r', 'Pending.swift', 'pending'), excluded = sourceFile('r', 'Excluded.swift', 'terminal');
  const seed = structuralFile('s', 'Seed.swift', [], ['Peer']), peer = structuralFile('s', 'Peer.swift', ['Peer'], []);
  const result = new StructureIndex({ roots: structuralRoots('r', 's'), entries: [pending, excluded, seed, peer] })
    .resolveAutomaticCodemapTargets([pending, excluded, seed]);
  const observed = schema.Parse(result);
  assert.deepEqual(result.targets, [peer]);
  assert.deepEqual(observedCoverage(observed), { status: 'partial', sourceIssues: [
    { source: { root: 'r', path: 'Excluded.swift' }, kind: 'sourceExcluded', disposition: 'unmapped' },
    { source: { root: 'r', path: 'Pending.swift' }, kind: 'sourcePending', disposition: 'pending' },
  ] });
});
