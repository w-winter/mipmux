import type { InventorySnapshot, InventoryEntry, SourcePath } from '../contracts/inventory.js';
import { compareBytes, canonicalJSON, WorkspaceFailure } from './values.js';
import { structureId } from './structure-identity.js';
import { automaticQueryBudget, resolveAutomaticRoot, type AutomaticRootBudgetReason } from './automatic-root-query.js';
import { captureStructureFiles } from './structure-files.js';
import { evaluateStructureResidency, type StructureResidency, type GraphRevocation } from './structure-residency.js';
import { automaticRootCoverage, aggregateAutomaticCoverage, type AutomaticCoverage, type AutomaticRootCoverage } from './automatic-source-coverage.js';

export type StructureFile = Extract<InventoryEntry, { kind: 'file' }>;
type AutomaticQueryResult =
  | { readonly kind: 'ready'; readonly targets: readonly StructureFile[] }
  | { readonly kind: 'queryBudget'; readonly targets: readonly StructureFile[]; readonly rejections: readonly QueryRejection[] }
  | { readonly kind: 'targetDemandLimit'; readonly targets: readonly []; readonly attempted: number; readonly limit: number };
/** Query admission is separate from source coverage; an admitted query can have pending sources. */
export type AutomaticCodemapTargets = AutomaticQueryResult & { readonly coverage: AutomaticCoverage };
type QueryRejection =
  | { readonly kind: 'sourceLimit' | 'rootLimit'; readonly attempted: number; readonly limit: number }
  | (AutomaticRootBudgetReason & { readonly root: string })
  | { readonly kind: 'graphRevoked'; readonly root: string; readonly reason: GraphRevocation };
interface RootCandidates {
  readonly id: string;
  readonly root: InventorySnapshot['roots'][number];
  readonly entries: InventoryEntry[];
  readonly definitions: Map<string, StructureFile[]>;
  residency: StructureResidency | null;
}
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
    for (const root of snapshot.roots) this.#roots.set(root.name, { id: structureId(root.identity, null), root,
      entries: [], definitions: new Map(), residency: null });
    for (const entry of snapshot.entries) {
      if (entry.kind !== 'file' && entry.kind !== 'acquisitionFailed') continue;
      const root = this.#roots.get(entry.root);
      if (!root) throw new WorkspaceFailure('unknownRoot');
      root.entries.push(entry);
      if (entry.kind === 'file') this.#indexFile(root, entry);
    }
  }

  #indexFile(root: RootCandidates, file: StructureFile): void {
    this.#files.set(sourceKey(file), file);
    if (file.visibility === 'managedOnly' || file.structural.kind !== 'artifact') return;
    const record = file.structural.record;
    if (record.outcome.kind !== 'ready' || !record.projection) return;
    for (const name of new Set(record.projection.definedTypeNames.map(name => name.normalize('NFC')))) {
      const list = root.definitions.get(name) ?? [];
      list.push(file); root.definitions.set(name, list);
    }
  }

  /**
   * One-hop, root-local targets, excluding seeds and the sources already chosen as codemaps; common-name suppression
   * precedes that exclusion.
   */
  resolveAutomaticCodemapTargets(seeds: readonly SourcePath[], chosen: readonly SourcePath[], unavailableRoots: ReadonlySet<string>): AutomaticCodemapTargets {
    const grouped = this.#groupSources(seeds);
    const sourceCount = [...grouped.values()].reduce((sum, group) => sum + group.length, 0);
    if (sourceCount > maximumRawSourceCount) return { kind: 'queryBudget', targets: [], rejections: [
      { kind: 'sourceLimit', attempted: sourceCount, limit: maximumRawSourceCount },
    ], coverage: aggregateAutomaticCoverage([]) };
    if (grouped.size > maximumRootCount) return { kind: 'queryBudget', targets: [], rejections: [
      { kind: 'rootLimit', attempted: grouped.size, limit: maximumRootCount },
    ], coverage: aggregateAutomaticCoverage([]) };
    const ordered = [...grouped].sort(([left], [right]) => compareBytes(this.#roots.get(left)!.id, this.#roots.get(right)!.id));
    const remaining = { ...automaticQueryBudget }, targets: StructureFile[] = [], rejections: QueryRejection[] = [];
    const coverageRoots: AutomaticRootCoverage[] = [];
    for (const [name, sources] of ordered) {
      const root = this.#roots.get(name)!;
      if (unavailableRoots.has(name)) {
        coverageRoots.push({ status: 'pending', sourceIssues: [], targetCount: 0 }); continue;
      }
      if (root.residency === null) root.residency = evaluateStructureResidency(captureStructureFiles(root.root, root.entries), root.definitions);
      if (root.residency.kind === 'revoked') {
        rejections.push({ kind: 'graphRevoked', root: name, reason: root.residency.reason });
        coverageRoots.push({ status: 'unavailable', sourceIssues: [], targetCount: 0 }); continue;
      }
      const result = resolveAutomaticRoot({ seeds: sources, definitions: root.definitions, budget: remaining,
        chosen: new Set(chosen.flatMap(source => source.root === name ? [source.path] : [])) });
      if (result.kind === 'budget') {
        rejections.push({ root: name, ...result.reason });
        coverageRoots.push({ status: 'unavailable', sourceIssues: [], targetCount: 0 }); continue;
      }
      coverageRoots.push(automaticRootCoverage(root.root, captureStructureFiles(root.root, sources), result.targets.length));
      for (const target of result.targets) targets.push(target);
      remaining.targets -= result.counts.targets; remaining.resolutions -= result.counts.resolutions;
      remaining.referenceFailures -= result.counts.referenceFailures; remaining.bytes -= result.counts.bytes;
    }
    if (targets.length > maximumCandidateDemandCount) {
      return { kind: 'targetDemandLimit', targets: [], attempted: targets.length, limit: maximumCandidateDemandCount,
        coverage: aggregateAutomaticCoverage([]) };
    }
    const coverage = aggregateAutomaticCoverage(coverageRoots);
    return rejections.length ? { kind: 'queryBudget', targets, rejections, coverage } : { kind: 'ready', targets, coverage };
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
