import type { ContextBuildRequest, Manifest } from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { type Material, normalizeRanges, sourceId } from './material-store.js';
import { canonicalJSON, WorkspaceFailure } from '../workspace/values.js';
import { manualIncludesFiles } from './manual-presentation.js';

/** Required bodies cannot be satisfied by a preset that excludes file content. */
export function assertClipboardRequiredMaterials(request: ContextBuildRequest, materials: readonly Material[]): void {
  if (manualIncludesFiles(request)) return;
  const ids = [...request.requiredSources.filter(selection => request.copyPreset === 'diffFollowUp' || selection.kind !== 'codemap').map(selection => sourceId(selection.source)), ...request.documents.map(input => 'document:' + input.id),
    ...materials.flatMap(({ record }) => record.kind === 'document' || record.kind === 'source' && record.required &&
      (request.copyPreset === 'diffFollowUp' || record.selection.kind !== 'codemap') ? [record.id] : [])];
  if (ids.length) throw new WorkspaceFailure('copyPresetRequiredMaterialConflict', { copyPreset: request.copyPreset, materialIds: [...new Set(ids)] });
}

/** Excluded selections bind Git scope to captured inventory, not to an archive of undelivered bodies. */
export function verifyExcludedSources(manifest: Manifest): void {
  const invalid = () => { throw new WorkspaceFailure('bundleIntegrityFailed'); };
  if (manifest.request.copyPreset !== 'diffFollowUp') {
    if (manifest.excludedSources.length) invalid();
    return;
  }
  if (manifest.request.requiredSources.length || manifest.request.documents.length || manifest.automaticCodemaps.length ||
    manifest.materials.some(record => record.kind !== 'patch' && record.kind !== 'gitPatch') || manifest.fileTree.input !== null) invalid();
  const seen = new Set([...manifest.unavailableRoots.flatMap(root => root.sources), ...manifest.unavailableFiles].map(source => source.id));
  for (const selection of manifest.excludedSources) {
    const id = sourceId(selection.source);
    const entry = manifest.inventory.entries.find(entry => sourceId(entry) === id);
    if (seen.has(id) || entry?.kind !== 'file' || manifest.unavailableRoots.some(root => root.root === entry.root) ||
      manifest.codemapMode === 'automatic' && selection.kind === 'codemap') invalid();
    seen.add(id);
    if (selection.kind !== 'slices') continue;
    try { normalizeRanges(selection.ranges, Number.MAX_SAFE_INTEGER); }
    catch (error) { if (!(error instanceof WorkspaceFailure)) throw error; invalid(); }
  }
}

export async function revalidateExcludedSources(operation: WorkspaceOperation, manifest: Manifest): Promise<void> {
  for (const selection of manifest.manualPresentation?.canonicalSources ?? manifest.excludedSources) {
    if (manifest.unavailableRoots.some(root => root.root === selection.source.root) || manifest.unavailableFiles.some(file => file.id === sourceId(selection.source))) continue;
    const entry = manifest.inventory.entries.find(entry => sourceId(entry) === sourceId(selection.source));
    if (entry?.kind !== 'file') throw new WorkspaceFailure('bundleIntegrityFailed');
    const current = await operation.sourceAvailability(selection.source);
    if (current.kind !== 'available' || canonicalJSON(current.identity) !== canonicalJSON(entry.identity)) {
      throw new WorkspaceFailure('sourceChanged', selection.source);
    }
  }
}
