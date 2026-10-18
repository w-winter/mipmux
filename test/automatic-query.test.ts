import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { StructureIndex } from '../src/workspace/structure-index.js';
import { structuralFile, structuralRoots } from './fixtures/structural-inventory.js';

test('automatic query applies the RP candidate threshold before seed exclusion', () => {
  for (const count of [4096, 4097]) {
    const seed = structuralFile('r', 'seed.swift', ['Shared'], ['Shared']);
    const candidates = Array.from({ length: count - 1 }, (_, index) => structuralFile('r', `${index}.swift`, ['Shared'], []));
    const index = new StructureIndex({ entries: [seed, ...candidates], roots: structuralRoots('r') });
    const selectedSeeds = [seed, ...candidates.slice(0, count - 1025)];
    assert.equal(index.resolveAutomaticCodemapTargets(selectedSeeds, new Set()).targets.length, count === 4096 ? 1024 : 0);
  }
});

test('automatic membership matches a root-local normalized oracle and is independent of seed order', () => {
  const name = fc.constantFrom('Peer', 'peer', 'Å', 'A\u030a');
  fc.assert(fc.property(fc.array(fc.record({ root: fc.constantFrom('r', 's'), definitions: fc.array(name),
    references: fc.array(name), selected: fc.boolean(), supported: fc.boolean() })), inputs => {
    const files = inputs.map((input, index) => {
      const file = structuralFile(input.root, `${index}.swift`, input.definitions, input.references);
      return input.supported ? file : { ...file, structural: { kind: 'unsupported' as const } };
    });
    const seeds = files.filter((_, index) => inputs[index]!.selected), seedPaths = new Set(seeds.map(seed => seed.path));
    const expected = files.filter((candidate, index) => !seedPaths.has(candidate.path) && inputs[index]!.supported &&
      inputs.some(seed => seed.selected && seed.supported && seed.root === candidate.root &&
        seed.references.some(reference => inputs[index]!.definitions.some(definition => definition.normalize('NFC') === reference.normalize('NFC')))))
      .map(file => file.root + '/' + file.path).sort();
    const index = new StructureIndex({ entries: files, roots: structuralRoots('r', 's') });
    const selected = index.resolveAutomaticCodemapTargets(seeds, new Set());
    assert.deepEqual(selected.targets.map(file => file.root + '/' + file.path).sort(), expected);
    assert.deepEqual(index.resolveAutomaticCodemapTargets([...seeds].reverse(), new Set()), selected);
  }));
});
