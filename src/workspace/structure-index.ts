import type { InventorySnapshot, InventoryEntry, SourcePath } from '../contracts/inventory.js';
import { compareBytes, canonicalJSON, WorkspaceFailure } from './values.js';
import { structureId } from './structure-identity.js';
import { automaticQueryBudget, resolveAutomaticRoot, type AutomaticRootBudgetReason } from './automatic-root-query.js';

export type StructureFile = Extract<InventoryEntry, { kind: 'file' }>;
type AutomaticCodemapTargets =
  | { readonly kind: 'ready'; readonly targets: readonly StructureFile[] }
  | { readonly kind: 'queryBudget'; readonly targets: readonly StructureFile[]; readonly rejections: readonly QueryRejection[] }
  | { readonly kind: 'targetDemandLimit'; readonly targets: readonly []; readonly attempted: number; readonly limit: number };
type QueryRejection =
  | { readonly kind: 'sourceLimit' | 'rootLimit'; readonly attempted: number; readonly limit: number }
  | (AutomaticRootBudgetReason & { readonly root: string });
interface RootCandidates { readonly id: string; readonly definitions: Map<string, StructureFile[]> }
const sourceKey = (file: SourcePath) => canonicalJSON({ root: file.root, path: file.path });
const maximumRawSourceCount = 4096;
const maximumRootCount = 64;
// RPCE's default WorkspaceCodemapAutomaticSelectionRequestPolicy caps target materialization.
const maximumCandidateDemandCount = 1024;

/** Root-local posting lists retain all syntactic candidates for a name. */
export class StructureIndex {
  readonly #files = new Map<string, StructureFile>();
  readonly #roots = new Map<string, RootCandidates>();
  constructor(snapshot: Pick<InventorySnapshot, 'entries' | 'roots'>) {
    for (const root of snapshot.roots) this.#roots.set(root.name, { id: structureId(root.identity, null), definitions: new Map() });
    for (const entry of snapshot.entries) {
      if (entry.kind !== 'file') continue;
      const root = this.#roots.get(entry.root);
      if (!root) throw new WorkspaceFailure('unknownRoot');
      this.#files.set(sourceKey(entry), entry);
      if (entry.visibility === 'managedOnly' || entry.structural.kind !== 'artifact') continue;
      const record = entry.structural.record;
      if (record.outcome.kind !== 'ready' || !record.projection) continue;
      for (const name of new Set(record.projection.definedTypeNames.map(name => name.normalize('NFC')))) {
        const list = root.definitions.get(name) ?? [];
        list.push(entry); root.definitions.set(name, list);
      }

    }
  }

  /** One-hop, root-local targets, excluding seeds; common-name suppression precedes seed exclusion. */
  resolveAutomaticCodemapTargets(seeds: readonly SourcePath[]): AutomaticCodemapTargets {
    const grouped = this.#groupSources(seeds);
    const sourceCount = [...grouped.values()].reduce((sum, group) => sum + group.length, 0);
    if (sourceCount > maximumRawSourceCount) return { kind: 'queryBudget', targets: [], rejections: [
      { kind: 'sourceLimit', attempted: sourceCount, limit: maximumRawSourceCount },
    ] };
    if (grouped.size > maximumRootCount) return { kind: 'queryBudget', targets: [], rejections: [
      { kind: 'rootLimit', attempted: grouped.size, limit: maximumRootCount },
    ] };
    const ordered = [...grouped].sort(([left], [right]) => compareBytes(this.#roots.get(left)!.id, this.#roots.get(right)!.id));
    const remaining = { ...automaticQueryBudget }, targets: StructureFile[] = [], rejections: QueryRejection[] = [];
    for (const [name, sources] of ordered) {
      const root = this.#roots.get(name)!;
      const result = resolveAutomaticRoot({ seeds: sources, definitions: root.definitions, budget: remaining });
      if (result.kind === 'budget') { rejections.push({ root: name, ...result.reason }); continue; }
      for (const target of result.targets) targets.push(target);
      remaining.targets -= result.counts.targets; remaining.resolutions -= result.counts.resolutions;
      remaining.referenceFailures -= result.counts.referenceFailures; remaining.bytes -= result.counts.bytes;
    }
    if (targets.length > maximumCandidateDemandCount) {
      return { kind: 'targetDemandLimit', targets: [], attempted: targets.length, limit: maximumCandidateDemandCount };
    }
    return rejections.length ? { kind: 'queryBudget', targets, rejections } : { kind: 'ready', targets };
  }

  #groupSources(seeds: readonly SourcePath[]): Map<string, StructureFile[]> {
    const groups = new Map<string, StructureFile[]>();
    for (const key of new Set(seeds.map(sourceKey))) {
      const seed = this.#files.get(key);
      if (!seed) throw new WorkspaceFailure('unavailableSource');
      if (seed.visibility === 'managedOnly') continue;
      const group = groups.get(seed.root) ?? []; group.push(seed); groups.set(seed.root, group);
    }
    return groups;
  }

}
