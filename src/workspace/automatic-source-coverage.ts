import type { InventorySnapshot, SourcePath } from '../contracts/inventory.js';
import type { NativeStructureInput } from '../contracts/structure.js';
import { structureId } from './structure-identity.js';
import { compareBytes } from './values.js';

export interface AutomaticSourceIssue {
  readonly source: SourcePath;
  readonly kind: 'sourcePending' | 'sourceNotIndexed' | 'sourceExcluded';
  readonly disposition: 'pending' | 'unmapped';
  readonly rootID: string;
  readonly fileID: string;
}
export interface AutomaticCoverage {
  readonly status: 'ok' | 'partial' | 'pending' | 'unavailable';
  readonly sourceIssues: readonly AutomaticSourceIssue[];
}
export interface AutomaticRootCoverage extends AutomaticCoverage {
  readonly targetCount: number;
}
const sourceIssuePrecedes = (left: AutomaticSourceIssue, right: AutomaticSourceIssue) =>
  compareBytes(left.kind, right.kind) || compareBytes(left.rootID, right.rootID) || compareBytes(left.fileID, right.fileID);

/** Classifies selected slots after an admitted query, with a current unfenced receipt. */
export function automaticRootCoverage(root: InventorySnapshot['roots'][number], slots: NativeStructureInput['roots'][number]['files'],
  targetCount: number): AutomaticRootCoverage {
  const rootID = structureId(root.identity, null), sourceIssues: AutomaticSourceIssue[] = [];
  for (const slot of slots) {
    const source = { root: root.name, path: slot.path }, identity = { rootID, fileID: slot.id };
    switch (slot.state) {
      case 'pending': sourceIssues.push({ source, ...identity, kind: 'sourcePending', disposition: 'pending' }); break;
      case null: sourceIssues.push({ source, ...identity, kind: 'sourceNotIndexed', disposition: 'unmapped' }); break;
      case 'terminalArtifact': case 'terminalExcluded':
        sourceIssues.push({ source, ...identity, kind: 'sourceExcluded', disposition: 'unmapped' }); break;
      case 'contributed': case 'empty': break;
    }
  }
  sourceIssues.sort(sourceIssuePrecedes);
  const hasPendingSource = sourceIssues.some(issue => issue.kind === 'sourcePending' || issue.kind === 'sourceNotIndexed');
  let status: AutomaticCoverage['status'] = 'ok';
  if (targetCount > 0 && sourceIssues.length) status = 'partial';
  else if (hasPendingSource) status = targetCount > 0 ? 'partial' : 'pending';
  return { status, sourceIssues, targetCount };
}

/** Uses RPCE's aggregate order: all-ok first, then useful targets, pending coverage, unavailable. */
export function aggregateAutomaticCoverage(roots: readonly AutomaticRootCoverage[]): AutomaticCoverage {
  if (!roots.length) return { status: 'unavailable', sourceIssues: [] };
  if (roots.every(root => root.status === 'ok')) return { status: 'ok', sourceIssues: [] };
  const sourceIssues = roots.flatMap(root => root.sourceIssues).sort(sourceIssuePrecedes);
  if (roots.some(root => root.targetCount > 0)) return { status: 'partial', sourceIssues };
  return { status: roots.some(root => root.status === 'pending' || root.status === 'partial') ? 'pending' : 'unavailable', sourceIssues };
}
