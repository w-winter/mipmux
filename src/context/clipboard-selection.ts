import type { CapturedContextBuildRequest, Manifest } from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { type Material, sourceId } from './material-store.js';
import { canonicalJSON, WorkspaceFailure } from '../workspace/values.js';

/** Required bodies cannot be satisfied by a preset that excludes file content. */
export function assertClipboardRequiredMaterials(request: CapturedContextBuildRequest, materials: readonly Material[]): void {
  if (request.copyPreset.includeFiles) return;
  const ids = [...request.requiredSources.filter(selection => request.copyPreset.codeMapUsage === 'none' || selection.kind !== 'codemap').map(selection => sourceId(selection.source)), ...request.documents.map(input => 'document:' + input.id),
    ...materials.flatMap(({ record }) => record.kind === 'document' || record.kind === 'source' && record.required &&
      (request.copyPreset.codeMapUsage === 'none' || record.selection.kind !== 'codemap') ? [record.id] : [])];
  if (ids.length) throw new WorkspaceFailure('copyPresetRequiredMaterialConflict', { copyPreset: request.copyPreset, materialIds: [...new Set(ids)] });
}

export async function revalidateCanonicalSources(operation: WorkspaceOperation, manifest: Manifest): Promise<void> {
  if (manifest.manualPresentation === null) return;
  for (const selection of manifest.manualPresentation.canonicalSources) {
    if (manifest.unavailableRoots.some(root => root.root === selection.source.root) || manifest.unavailableFiles.some(file => file.id === sourceId(selection.source))) continue;
    const entry = manifest.inventory.entries.find(entry => sourceId(entry) === sourceId(selection.source));
    if (entry?.kind !== 'file') throw new WorkspaceFailure('bundleIntegrityFailed');
    const current = await operation.sourceAvailability(selection.source);
    if (current.kind !== 'available' || canonicalJSON(current.identity) !== canonicalJSON(entry.identity)) {
      throw new WorkspaceFailure('sourceChanged', selection.source);
    }
  }
}
