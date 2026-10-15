import type { InventorySnapshot, InventoryEntry, SourcePath } from '../contracts/inventory.js';
import { compareBytes, canonicalJSON, WorkspaceFailure } from './values.js';

export type StructureFile = Extract<InventoryEntry, { kind: 'file' }>;
type AutomaticCodemapTargets =
  | { readonly kind: 'ready'; readonly targets: readonly StructureFile[] }
  | { readonly kind: 'targetDemandLimit'; readonly targets: readonly []; readonly attempted: number; readonly limit: number };
const sourceKey = (file: SourcePath) => canonicalJSON({ root: file.root, path: file.path });
const symbolKey = (root: string, name: string) => canonicalJSON([root, name.normalize('NFC')]);
// RPCE's automatic matching suppresses a whole reference above this definition fanout.
const automaticCandidateLimit = 4096;
// RPCE's default WorkspaceCodemapAutomaticSelectionRequestPolicy caps target materialization.
const maximumCandidateDemandCount = 1024;

/** Root-local posting lists retain all syntactic candidates for a name. */
export class StructureIndex {
  readonly #files = new Map<string, StructureFile>();
  readonly #definitions = new Map<string, StructureFile[]>();
  constructor(snapshot: Pick<InventorySnapshot, 'entries'>) {
    for (const entry of snapshot.entries) {
      if (entry.kind !== 'file') continue;
      this.#files.set(sourceKey(entry), entry);
      if (entry.visibility === 'managedOnly' || entry.structural.kind !== 'artifact') continue;
      const record = entry.structural.record;
      if (record.outcome.kind !== 'ready' || !record.projection) continue;
      for (const name of new Set(record.projection.definedTypeNames.map(name => name.normalize('NFC')))) {
        const key = symbolKey(entry.root, name), list = this.#definitions.get(key) ?? [];
        list.push(entry); this.#definitions.set(key, list);
      }

    }
  }

  /** One-hop, root-local targets, excluding seeds; common-name suppression precedes seed exclusion. */
  resolveAutomaticCodemapTargets(seeds: readonly SourcePath[]): AutomaticCodemapTargets {
    const seedKeys = new Set(seeds.map(sourceKey)), targets = new Map<string, StructureFile>();
    for (const symbol of this.#automaticReferenceNames(seedKeys)) {
      const candidates = this.#definitions.get(symbol) ?? [];
      if (candidates.length > automaticCandidateLimit) continue;
      for (const candidate of candidates) {
        const candidateKey = sourceKey(candidate);
        if (!seedKeys.has(candidateKey)) targets.set(candidateKey, candidate);
      }
    }
    if (targets.size > maximumCandidateDemandCount) {
      return { kind: 'targetDemandLimit', targets: [], attempted: targets.size, limit: maximumCandidateDemandCount };
    }
    return { kind: 'ready', targets: [...targets.values()].sort((a, b) => compareBytes(a.root, b.root) || compareBytes(a.path, b.path)) };
  }

  #automaticReferenceNames(seedKeys: ReadonlySet<string>): Set<string> {
    const names = new Set<string>();
    for (const key of seedKeys) {
      const seed = this.#files.get(key);
      if (!seed) throw new WorkspaceFailure('unavailableSource');
      if (seed.visibility === 'managedOnly' || seed.structural.kind !== 'artifact') continue;
      const record = seed.structural.record;
      if (record.outcome.kind !== 'ready' || !record.projection) continue;
      for (const name of record.outcome.artifact.referencedTypes) {
        names.add(symbolKey(seed.root, name));
      }
    }
    return names;
  }

}
