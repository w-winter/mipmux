import type { StructureFile } from './structure-index.js';

const maximumDefinitionCandidates = 4096;

/** Groups matching names per source-to-target edge and retains unresolved normalized names. */
export function resolveStructureEvidence(references: readonly string[], definitions: ReadonlyMap<string, readonly StructureFile[]>) {
  const edges = new Map<string, { target: StructureFile; symbols: Set<string> }>(), unresolved: string[] = [];
  for (const name of new Set(references.map(name => name.normalize('NFC')))) {
    const candidates = definitions.get(name) ?? [];
    if (!candidates.length || candidates.length > maximumDefinitionCandidates) { unresolved.push(name); continue; }
    for (const target of candidates) {
      const edge = edges.get(target.path) ?? { target, symbols: new Set<string>() };
      edge.symbols.add(name); edges.set(target.path, edge);
    }
  }
  return { edges: [...edges.values()].map(edge => ({ target: edge.target, symbols: [...edge.symbols] })), unresolved };
}
