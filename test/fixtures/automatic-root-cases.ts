import { structuralFile } from './structural-inventory.js';

const budget = { targets: 100000, resolutions: 100000, referenceFailures: 100000, bytes: 64 * 1024 * 1024 };
const missing = Array.from({ length: 101 }, (_, index) => 'Missing' + index);
export const automaticRootCases = [
  { name: 'shared-resolution-boundary', files: [
    { path: 'Seed{i}.swift', count: 1000, selected: true, definitions: [], references: ['Peer', 'Alias'] },
    { path: 'Peer{i}.swift', count: 100, selected: false, definitions: ['Peer', 'Alias'], references: [] },
  ], budget },
  { name: 'shared-resolution-overflow', files: [
    { path: 'Seed{i}.swift', count: 1000, selected: true, definitions: [], references: ['Peer', 'Alias'] },
    { path: 'Peer{i}.swift', count: 101, selected: false, definitions: ['Peer', 'Alias'], references: [] },
  ], budget },
  { name: 'unresolved-per-source', files: [
    { path: 'Seed{i}.swift', count: 1000, selected: true, definitions: [], references: ['Peer', ...missing, ...missing] },
    { path: 'Peer.swift', count: 1, selected: false, definitions: ['Peer'], references: [] },
  ], budget },
  { name: 'selected-edge-counts', files: [
    { path: 'Seed.swift', count: 1, selected: true, definitions: ['Peer'], references: ['Peer'] },
  ], budget: { ...budget, resolutions: 0 } },
  { name: 'remaining-target-budget', files: [
    { path: 'Seed.swift', count: 1, selected: true, definitions: [], references: ['Peer'] },
    { path: 'Peer.swift', count: 1, selected: false, definitions: ['Peer'], references: [] },
  ], budget: { ...budget, targets: 0 } },
  { name: 'utf8-byte-boundary', files: [
    { path: 'Seed.swift', count: 1, selected: true, definitions: [], references: ['Peer'] },
    { path: 'é.swift', count: 1, selected: false, definitions: ['Peer'], references: [] },
  ], budget: { ...budget, bytes: 72 } },
  { name: 'utf8-byte-overflow', files: [
    { path: 'Seed.swift', count: 1, selected: true, definitions: [], references: ['Peer'] },
    { path: 'é.swift', count: 1, selected: false, definitions: ['Peer'], references: [] },
  ], budget: { ...budget, bytes: 71 } },
  { name: 'too-common-is-a-reference-failure', files: [
    { path: 'Seed.swift', count: 1, selected: true, definitions: [], references: ['Peer'] },
    { path: 'Peer{i}.swift', count: 4097, selected: false, definitions: ['Peer'], references: [] },
  ], budget: { ...budget, referenceFailures: 0 } },
];

export function automaticRootInput(entry: typeof automaticRootCases[number]) {
  const files = entry.files.flatMap(group => Array.from({ length: group.count }, (_, index) => ({
    file: structuralFile('r', group.path.replace('{i}', String(index)), group.definitions, group.references), selected: group.selected,
  })));
  const definitions = new Map<string, typeof files[number]['file'][]>();
  for (const { file } of files) for (const name of new Set(file.structural.kind === 'artifact' && file.structural.record.projection
    ? file.structural.record.projection.definedTypeNames.map(name => name.normalize('NFC')) : [])) {
    const matches = definitions.get(name) ?? []; matches.push(file); definitions.set(name, matches);
  }
  return { seeds: files.filter(file => file.selected).map(file => file.file), definitions, budget: entry.budget };
}
