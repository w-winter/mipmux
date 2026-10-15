import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { StructureIndex, type StructureFile } from '../src/workspace/structure-index.js';
import { automaticRootCoverage, aggregateAutomaticCoverage, type AutomaticCoverage } from '../src/workspace/automatic-source-coverage.js';
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

const sourceIssueKind = Type.Enum(['sourcePending', 'sourceNotIndexed', 'sourceExcluded']);
const referenceIssue = Type.Union([
  Type.Object({ kind: sourceIssueKind, root: Type.String(), path: Type.String() }),
  Type.Object({ kind: Type.Enum(['graphNotInitialized', 'graphUnavailable']), root: Type.String() }),
  Type.Object({ kind: Type.Literal('emptySources') }),
]);
const referenceInputs = Compile(Type.Object({ rootLabels: Type.Array(Type.String()), cases: Type.Array(Type.Object({
  name: Type.String(), roots: Type.Array(Type.Object({ root: Type.String(),
    kind: Type.Enum(['ready', 'pendingAggregateInput', 'unavailableAggregateInput']), targets: Type.Array(Type.String()),
    sources: Type.Array(Type.Object({ path: Type.String(), slot: Type.Union([
      Type.Enum(['contributed', 'empty', 'pending', 'terminalArtifact', 'terminalExcluded']), Type.Null(),
    ]) })),
  })),
})) }));
const coverageStatus = Type.Enum(['ok', 'partial', 'pending', 'unavailable']);
const referenceOutputs = Compile(Type.Array(Type.Object({ name: Type.String(), expected: Type.Object({
  aggregateCoverage: Type.Union([Type.Object({ status: Type.Literal('ok') }),
    Type.Object({ status: Type.Enum(['partial', 'pending', 'unavailable']), issues: Type.Array(referenceIssue) })]),
  roots: Type.Array(Type.Object({ root: Type.String(), status: coverageStatus })),
}) })));

function observedCoverage(result: ReturnType<typeof schema.Parse>) {
  return { status: result.coverage.status, sourceIssues: result.coverage.sourceIssues.map(issue => ({
    source: issue.source, kind: issue.kind, disposition: issue.disposition,
  })) };
}

test('automatic source classification preserves source aggregate coverage and file diagnostics', async () => {
  const directory = 'test/fixtures/rpce-automatic-source-coverage/';
  const inputs = referenceInputs.Parse(JSON.parse(await readFile(directory + 'inputs.json', 'utf8')));
  const outputs = referenceOutputs.Parse(JSON.parse(await readFile(directory + 'expected.json', 'utf8')));
  const proof: { name: string; status: AutomaticCoverage['status'] }[] = [];
  for (const entry of inputs.cases) {
    const reference = outputs.find(output => output.name === entry.name); assert(reference);
    const roots = entry.roots.map(root => {
      if (root.kind !== 'ready') return { status: root.kind === 'pendingAggregateInput' ? 'pending' as const : 'unavailable' as const,
        sourceIssues: [], targetCount: 0 };
      const declaredRoot = structuralRoots(...inputs.rootLabels).find(value => value.name === root.root); assert(declaredRoot);
      return automaticRootCoverage(declaredRoot, root.sources.map((source, index) => ({ path: source.path,
        id: '20000000-0000-0000-0000-' + String(index + 1).padStart(12, '0'), state: source.slot,
        definitions: [], references: [], signature: null })), root.targets.length);
    });
    const observed = aggregateAutomaticCoverage(roots), expected = reference.expected.aggregateCoverage;
    assert.equal(observed.status, expected.status, entry.name);
    const issues = expected.status === 'ok' ? [] : expected.issues.filter(issue =>
      issue.kind === 'sourcePending' || issue.kind === 'sourceNotIndexed' || issue.kind === 'sourceExcluded');
    assert.deepEqual(observed.sourceIssues.map(issue => ({ kind: issue.kind, root: issue.source.root, path: issue.source.path })), issues, entry.name);
    const originalStatuses = new Map(reference.expected.roots.map(root => [root.root, root.status]));
    for (const [index, root] of entry.roots.entries())
      assert.equal(roots[index]!.status, originalStatuses.get(root.root), entry.name + ':' + root.root);
    proof.push({ name: entry.name, status: observed.status });
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
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/automatic-source-classification-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
