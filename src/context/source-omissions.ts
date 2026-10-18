import type { CodemapMode, Manifest, MaterialRecord, SourceSelection, UnavailableFile, UnavailableRoot } from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { Material } from './material-store.js';
import { sourceId } from './material-store.js';
import { canonicalJSON, freeze, WorkspaceFailure } from '../workspace/values.js';
import { descriptorGitMode } from '../contracts/patches.js';

export async function captureUnavailableRoots(operation: WorkspaceOperation): Promise<readonly UnavailableRoot[]> {
  const roots: UnavailableRoot[] = [];
  for (const root of operation.snapshot.roots) {
    const state = await operation.sourceRootAvailability(root.name);
    if (state.kind === 'unavailable') roots.push({ root: root.name, code: state.code, sources: [] });
  }
  return freeze(roots);
}

/** Omits only optional source bodies; supplied evidence and required inputs keep their ordinary verification. */
export async function packetSources(operation: WorkspaceOperation, materials: readonly Material[], unavailable: readonly UnavailableRoot[]) {
  const roots = new Map(unavailable.map(root => [root.root, { ...root, sources: [...root.sources] }]));
  const delivered: Material[] = [], unavailableFiles: UnavailableFile[] = [];
  const indexes = new Map(materials.filter(({ record }) => record.kind === 'source' && record.selectionOrigin === 'explicit')
    .map(({ record }, index) => [record.id, index]));
  for (const material of materials) {
    const record = material.record;
    if (record.kind !== 'source') { delivered.push(material); continue; }
    const root = roots.get(record.selection.source.root);
    if (!root) {
      if (material.availability === 'unavailableCodemap') {
        if (material.record.required) throw new WorkspaceFailure(material.cause, material.record.selection.source);
        const file = { id: material.record.id, selection: material.record.selection, identity: material.record.identity,
          mode: material.record.mode, selectionIndex: indexes.get(material.record.id)!, code: material.cause,
          artifactKey: material.record.artifactKey, disposition: material.disposition };
        await revalidateFileAvailability(operation, [file]);
        unavailableFiles.push(file); continue;
      }
      const file = await captureUnavailableFile(operation, record, indexes, material.availability);
      if (file) unavailableFiles.push(file);
      else delivered.push(material);
      continue;
    }
    if (record.required) throw new WorkspaceFailure(root.code, { ...record.selection.source, required: true });
    if (record.selectionOrigin === 'explicit') root.sources.push({ id: record.id, selection: record.selection, identity: record.identity,
      mode: record.mode, selectionIndex: indexes.get(record.id)! });
  }
  return freeze({ materials: delivered, unavailableRoots: [...roots.values()], unavailableFiles });
}

async function captureUnavailableFile(operation: WorkspaceOperation, record: Extract<MaterialRecord, { kind: 'source' }>, indexes: ReadonlyMap<string, number>, availability: Material['availability']): Promise<UnavailableFile | null> {
  if (record.selection.kind === 'codemap') {
    if (record.selectionOrigin !== 'explicit' || availability !== 'pendingCodemap' || record.required) return null;
    const artifactKey = await revalidateCodemapSource(operation, record);
    return { id: record.id, selection: record.selection, identity: record.identity, mode: record.mode,
      selectionIndex: indexes.get(record.id)!, code: 'codemapPending', artifactKey };
  }
  const state = await operation.sourceAvailability(record.selection.source);
  if (state.kind === 'available') return null;
  if (record.required) throw new WorkspaceFailure(state.code, { ...record.selection.source, required: true });
  return { id: record.id, selection: record.selection, identity: record.identity, mode: record.mode,
    selectionIndex: indexes.get(record.id)!, code: state.code };
}

async function revalidateCodemapSource(operation: WorkspaceOperation,
  source: Pick<Extract<MaterialRecord, { kind: 'source' }>, 'selection' | 'identity' | 'mode' | 'artifactKey'>) {
  const state = await operation.sourceAvailability(source.selection.source);
  if (state.kind === 'unavailable') throw new WorkspaceFailure(state.code, source.selection.source);
  if (state.key === null || canonicalJSON([state.identity, descriptorGitMode(state.mode), state.key]) !==
    canonicalJSON([source.identity, source.mode, source.artifactKey])) throw new WorkspaceFailure('sourceChanged', source.selection.source);
  return state.key;
}

export function capturedSourceSelections(materials: readonly Material[], roots: readonly UnavailableRoot[], files: readonly UnavailableFile[]): SourceSelection[] {
  const selections = materials.flatMap(({ record }) => record.kind === 'source' && record.selectionOrigin === 'explicit' ? [record.selection] : []);
  const omitted = [...roots.flatMap(root => root.sources), ...files].sort((a, b) => a.selectionIndex - b.selectionIndex);
  for (const source of omitted) selections.splice(source.selectionIndex, 0, source.selection);
  return selections;
}

export async function revalidateFileAvailability(operation: WorkspaceOperation, files: readonly UnavailableFile[]): Promise<void> {
  for (const file of files) {
    if (file.code === 'codemapPending') { await revalidateCodemapSource(operation, file); continue; }
    const state = await operation.sourceAvailability(file.selection.source);
    if (state.kind !== 'unavailable' || state.code !== file.code) throw new WorkspaceFailure('sourceAvailabilityChanged', file.selection.source);
  }
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
  for (const file of manifest.unavailableFiles) {
    if (!roots.has(file.selection.source.root) || seenRoots.has(file.selection.source.root) ||
      file.id !== sourceId(file.selection.source) || sources.has(file.id) || required.has(file.id)) throw new WorkspaceFailure('bundleIntegrityFailed');
    sources.add(file.id);
    if (file.code === 'codemapPending') verifyPendingCodemap(manifest, file);
    if (file.selection.kind === 'codemap' && manifest.codemapMode !== 'manual') throw new WorkspaceFailure('bundleIntegrityFailed');
  }
  const omitted = [...manifest.unavailableRoots.flatMap(root => root.sources), ...manifest.unavailableFiles];
  const count = manifest.materials.filter(record => record.kind === 'source' && record.selectionOrigin === 'explicit').length + omitted.length;
  if (new Set(omitted.map(source => source.selectionIndex)).size !== omitted.length || omitted.some(source => source.selectionIndex >= count)) {
    throw new WorkspaceFailure('bundleIntegrityFailed');
  }
  for (const record of manifest.materials) {
    const root = requiredPhysicalRoot(record);
    if (root !== null && seenRoots.has(root)) throw new WorkspaceFailure('bundleIntegrityFailed');
  }
}

function verifyPendingCodemap(manifest: Manifest, file: Extract<UnavailableFile, { code: 'codemapPending' }>): void {
  const entry = manifest.inventory.entries.find(entry => entry.root === file.selection.source.root && entry.path === file.selection.source.path);
  if (manifest.codemapMode !== 'manual' || entry?.kind !== 'file' ||
    (entry.structural.kind !== 'pending' && entry.structural.kind !== 'artifact') ||
    canonicalJSON([entry.identity, entry.structural.key]) !== canonicalJSON([file.identity, file.artifactKey])) {
    throw new WorkspaceFailure('bundleIntegrityFailed');
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
