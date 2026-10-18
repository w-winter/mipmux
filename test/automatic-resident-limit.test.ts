import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { StructureIndex } from '../src/workspace/structure-index.js';
import { structuralFile, structuralRoots } from './fixtures/structural-inventory.js';

const maximumResidentNodes = 100000;

test('automatic membership rejects an oversized resident root without suppressing another root', async () => {
  const seed = structuralFile('r', 'Seed.swift', [], ['Peer']);
  const peer = structuralFile('r', 'Peer.swift', ['Peer'], []);
  const otherSeed = structuralFile('s', 'Seed.swift', [], ['Other']);
  const other = structuralFile('s', 'Other.swift', ['Other'], []);
  const entries = [seed, peer, ...Array.from({ length: maximumResidentNodes - 1 }, (_, index) =>
    structuralFile('r', 'Empty' + index + '.swift', [], [])), otherSeed, other];
  const roots = structuralRoots('r', 's');
  const rejected = new StructureIndex({ roots, entries }).resolveAutomaticCodemapTargets([seed, otherSeed], new Set());
  assert.deepEqual(rejected.targets, [other]);
  entries.splice(maximumResidentNodes, 1);
  const admitted = new StructureIndex({ roots, entries }).resolveAutomaticCodemapTargets([seed, otherSeed], new Set());
  assert.deepEqual(admitted.targets.map(file => file.root + '/' + file.path).sort(), ['r/Peer.swift', 's/Other.swift']);
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/automatic-resident-limit-proof.json', JSON.stringify({
    rejected, admitted: admitted.targets.map(file => ({ root: file.root, path: file.path })),
  }, null, 2) + '\n');
});
