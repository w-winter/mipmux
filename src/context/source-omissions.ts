import type { CodemapMode, Manifest, MaterialRecord, UnavailableRoot } from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { Material } from './material-store.js';
import { sourceId } from './material-store.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';

export async function captureUnavailableRoots(operation: WorkspaceOperation): Promise<readonly UnavailableRoot[]> {
  const roots: UnavailableRoot[] = [];
  for (const root of operation.snapshot.roots) {
    const state = await operation.sourceRootAvailability(root.name);
    if (state.kind === 'unavailable') roots.push({ root: root.name, code: state.code, sources: [] });
  }
  return freeze(roots);
}

/** Omits only optional source bodies; supplied evidence and required inputs keep their ordinary verification. */
export function packetSources(materials: readonly Material[], unavailable: readonly UnavailableRoot[]) {
  const roots = new Map(unavailable.map(root => [root.root, { ...root, sources: [...root.sources] }]));
  const delivered: Material[] = [];
  for (const material of materials) {
    const record = material.record;
    if (record.kind !== 'source') { delivered.push(material); continue; }
    const root = roots.get(record.selection.source.root);
    if (!root) { delivered.push(material); continue; }
    if (record.required) throw new WorkspaceFailure(root.code, { ...record.selection.source, required: true });
    if (record.selectionOrigin === 'explicit') root.sources.push({ id: record.id, selection: record.selection, identity: record.identity, mode: record.mode });
  }
  return freeze({ materials: delivered, unavailableRoots: [...roots.values()] });
}

export async function revalidateRootAvailability(operation: WorkspaceOperation, roots: readonly UnavailableRoot[]): Promise<void> {
  if (!roots.length) { await operation.validateRoots(); return; }
  const captured = new Map(roots.map(root => [root.root, root]));
  for (const root of operation.snapshot.roots) {
    const unavailable = captured.get(root.name);
    if (!unavailable) { await operation.validateSourceRoot(root.name); continue; }
    const current = await operation.sourceRootAvailability(root.name);
    if (current.kind !== 'unavailable' || current.code !== unavailable.code) {
      throw new WorkspaceFailure('sourceAvailabilityChanged', { root: root.name });
    }
  }
  await operation.validateOutputRoot();
}

export function verifySourceOmissions(manifest: Manifest): void {
  const roots = new Set(manifest.inventory.roots.map(root => root.name));
  const seenRoots = new Set<string>(), sources = new Set(manifest.materials.map(material => material.id));
  const required = new Set(manifest.request.requiredSources.map(source => sourceId(source.source)));
  for (const root of manifest.unavailableRoots) {
    if (!roots.has(root.root) || seenRoots.has(root.root)) throw new WorkspaceFailure('bundleIntegrityFailed');
    seenRoots.add(root.root);
    verifyRootSources(root, manifest.codemapMode, sources, required);
  }
  for (const record of manifest.materials) {
    const root = requiredPhysicalRoot(record);
    if (root !== null && seenRoots.has(root)) throw new WorkspaceFailure('bundleIntegrityFailed');
  }
}

function verifyRootSources(root: UnavailableRoot, mode: CodemapMode, sources: Set<string>, required: ReadonlySet<string>): void {
  for (const source of root.sources) {
    if (source.selection.source.root !== root.root || source.id !== sourceId(source.selection.source) || sources.has(source.id) || required.has(source.id)) {
      throw new WorkspaceFailure('bundleIntegrityFailed');
    }
    if (mode === 'automatic' && source.selection.kind === 'codemap') throw new WorkspaceFailure('bundleIntegrityFailed');
    sources.add(source.id);
  }
}

function requiredPhysicalRoot(record: MaterialRecord): string | null {
  switch (record.kind) {
    case 'source': return record.selection.source.root;
    case 'document': return record.input.kind === 'localDocument' ? record.input.source.root : null;
    case 'patch': return record.receipt.input.kind === 'localPatch' || record.receipt.policies.length ? record.receipt.input.root : null;
    case 'gitMap': case 'gitPatch': return record.reference.checkout.root;
  }
}
