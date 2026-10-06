import { treeValidator, type TreeRequest } from '../contracts/exploration.js';
import type { InventorySnapshot } from '../contracts/inventory.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { pageIdentity, pageOffset } from './continuation.js';
import { pageResult, type ResultEncoding } from './output-budget.js';

export function getFileTree(snapshot: InventorySnapshot, request: TreeRequest, encode?: ResultEncoding) {
  if (!treeValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  const selected = new Set(request.selection?.sources.map(source => JSON.stringify([source.root, source.path])));
  const roots = snapshot.roots.map(root => ({ root: root.name, path: '', kind: 'root', selected: false, structural: null, skippedReason: null }));
  const entries = snapshot.entries.map(entry => ({ root: entry.root, path: entry.path, kind: entry.kind,
    selected: selected.has(JSON.stringify([entry.root, entry.path])),
    skippedReason: entry.kind === 'skipped' ? entry.reason : null,
    structural: entry.kind === 'file' ? entry.structural.kind === 'unsupported' ? 'unsupported' : entry.structural.record.outcome.kind : null }));
  const view = request.view === 'roots' ? roots : entries.filter(entry => request.view === 'files' ? entry.kind === 'file' || entry.kind === 'acquisitionFailed' || entry.kind === 'skipped' :
    request.view === 'folders' ? entry.kind === 'directory' : entry.selected);
  const records = view.filter(entry => request.depth === null || entry.path.split('/').length <= request.depth);
  const { maxOutputBytes, continuation, ...settings } = request;
  const digest = pageIdentity(snapshot, settings, null);
  return pageResult(records, pageOffset(continuation, digest), maxOutputBytes, (entries, next) => ({
    kind: 'tree' as const, inventoryDigest: snapshot.inventoryDigest, view: request.view,
    requestedDepth: request.depth, depthOmitted: view.length - records.length, totalEntries: records.length,
    entries, truncated: next !== null, continuation: next === null ? null : { digest, offset: next },
  }), encode);
}
