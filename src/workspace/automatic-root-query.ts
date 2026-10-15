import type { StructureFile } from './structure-index.js';
import { compareBytes } from './values.js';

export interface AutomaticQueryBudget {
  readonly targets: number;
  readonly resolutions: number;
  readonly referenceFailures: number;
  readonly bytes: number;
}
export const automaticQueryBudget: AutomaticQueryBudget = {
  targets: 100000, resolutions: 100000, referenceFailures: 100000, bytes: 64 * 1024 * 1024,
};
export interface AutomaticRootBudgetReason {
  readonly kind: 'resolutionLimit' | 'referenceFailureLimit' | 'targetLimit' | 'byteLimit';
  readonly attempted: number;
  readonly limit: number;
}
type AutomaticRootResult =
  | { readonly kind: 'ready'; readonly targets: readonly StructureFile[]; readonly counts: AutomaticQueryBudget }
  | { readonly kind: 'budget'; readonly reason: AutomaticRootBudgetReason };

const maximumDefinitionCandidates = 4096;
const targetFixedBytes = 64;

function sourceEvidence(seed: StructureFile, definitions: ReadonlyMap<string, readonly StructureFile[]>) {
  const targets = new Map<string, StructureFile>();
  let referenceFailures = 0;
  if (seed.visibility === 'managedOnly' || seed.structural.kind !== 'artifact' || seed.structural.record.outcome.kind !== 'ready') {
    return { targets: [], referenceFailures };
  }
  const names = new Set(seed.structural.record.outcome.artifact.referencedTypes.map(name => name.normalize('NFC')));
  for (const name of names) {
    const candidates = definitions.get(name) ?? [];
    if (!candidates.length || candidates.length > maximumDefinitionCandidates) { referenceFailures++; continue; }
    for (const candidate of candidates) targets.set(candidate.path, candidate);
  }
  return { targets: [...targets.values()], referenceFailures };
}

/** Queries unique admitted seeds in one root; returns the first budget rejection or all path-ordered targets. */
export function resolveAutomaticRoot(input: { readonly seeds: readonly StructureFile[];
  readonly definitions: ReadonlyMap<string, readonly StructureFile[]>; readonly budget: AutomaticQueryBudget }): AutomaticRootResult {
  const selected = new Set(input.seeds.map(seed => seed.path)), targets = new Map<string, StructureFile>();
  let resolutions = 0, referenceFailures = 0;
  for (const seed of input.seeds) {
    const evidence = sourceEvidence(seed, input.definitions);
    resolutions += evidence.targets.length; referenceFailures += evidence.referenceFailures;
    for (const target of evidence.targets) if (!selected.has(target.path)) targets.set(target.path, target);
  }
  if (resolutions > input.budget.resolutions) return { kind: 'budget', reason: {
    kind: 'resolutionLimit', attempted: resolutions, limit: input.budget.resolutions,
  } };
  if (referenceFailures > input.budget.referenceFailures) return { kind: 'budget', reason: {
    kind: 'referenceFailureLimit', attempted: referenceFailures, limit: input.budget.referenceFailures,
  } };
  const ordered = [...targets.values()].sort((a, b) => compareBytes(a.path, b.path));
  if (ordered.length > input.budget.targets) return { kind: 'budget', reason: {
    kind: 'targetLimit', attempted: ordered.length, limit: input.budget.targets,
  } };
  const bytes = ordered.reduce((sum, file) => sum + targetFixedBytes + Buffer.byteLength(file.path), 0);
  if (bytes > input.budget.bytes) return { kind: 'budget', reason: {
    kind: 'byteLimit', attempted: bytes, limit: input.budget.bytes,
  } };
  return { kind: 'ready', targets: ordered, counts: { targets: ordered.length, resolutions, referenceFailures, bytes } };
}
