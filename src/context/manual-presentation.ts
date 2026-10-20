import { performance } from 'node:perf_hooks';
import { posix } from 'node:path';
import type { CapturedContextBuildRequest, ManualPresentation } from '../contracts/context.js';
import type { SourcePath } from '../contracts/inventory.js';
import type { NativeOperation } from '../contracts/native.js';
import type { CanonicalSelection } from './selection-preparation.js';
import type { RenderInput } from './render.js';
import type { MipmuxRuntime } from '../runtime/mipmux-runtime.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { codemapRepresentation, sourceId, prepareCodemapSelection, type Material } from './material-store.js';
import { capturedSourceSelections } from './source-omissions.js';
import { withCodemapPresentation } from './codemap-readiness.js';
import { structureId } from '../workspace/structure-identity.js';
import { WorkspaceFailure } from '../workspace/values.js';

type Input = Pick<RenderInput, 'request' | 'materials' | 'inventory' | 'codemapMode' | 'automaticAcquisition' | 'unavailableRoots' | 'unavailableFiles'>;
type PlanInput = Extract<NativeOperation, { kind: 'planClipboardPresentation' }>;

export function manualPlanInput(input: Input, proof: ManualPresentation): PlanInput {
  const key = (source: SourcePath) => '/' + source.root + '/' + source.path;
  const roots = input.inventory.roots.map(root => ({ id: structureId(root.identity, ''), standardizedFullPath: root.identity.canonicalPath }));
  return { kind: 'planClipboardPresentation', copyPreset: input.request.copyPreset,
    roots, files: input.inventory.entries.flatMap(entry => {
      if (entry.kind !== 'file') return [];
      const root = input.inventory.roots.find(root => root.name === entry.root)!;
      return [{ id: structureId(root.identity, entry.path), rootID: structureId(root.identity, ''), name: posix.basename(entry.path),
        standardizedRelativePath: entry.path, fullPath: key(entry) }];
    }), selection: { codemapAutoEnabled: input.codemapMode === 'automatic', selectedPaths: proof.directlySelected.map(key),
      manualCodemapPaths: proof.canonicalSources.filter(source => source.kind === 'codemap').map(source => key(source.source)),
      slices: Object.fromEntries(proof.canonicalSources.flatMap(source => source.kind === 'slices' ? [[key(source.source), source.ranges]] : [])) },
    readyFileIDs: proof.ready.map(source => structureId(input.inventory.roots.find(root => root.name === source.root)!.identity, source.path)) };
}

function sourcesForIDs(inventory: Input['inventory'], ids: readonly string[]): SourcePath[] {
  const catalog = new Map(inventory.entries.filter(entry => entry.kind === 'file').map(entry => {
    const root = inventory.roots.find(root => root.name === entry.root)!;
    return [structureId(root.identity, entry.path), { root: entry.root, path: entry.path }] as const;
  }));
  return ids.map(id => { const source = catalog.get(id); if (!source) throw new WorkspaceFailure('nativeProtocolError'); return source; });
}

function projectMaterials(input: Input, includeFiles: boolean, maps: ReadonlySet<string>, readyMaterials: readonly Material[]): Material[] {
  const readyByID = new Map(readyMaterials.map(material => [material.record.id, material]));
  const materials: Material[] = [];
  for (const material of input.materials) {
    const record = material.record;
    if (record.kind !== 'source') {
      if (record.kind === 'patch' || record.kind === 'gitPatch' || includeFiles) materials.push(material);
      continue;
    }
    if (record.selection.kind === 'codemap' && input.request.copyPreset.codeMapUsage === 'auto' && material.availability !== 'settled') {
      materials.push(material);
      continue;
    }
    if (record.selectionOrigin === 'inferred' || record.selection.kind === 'codemap' || maps.has(record.id)) continue;
    if (includeFiles) materials.push(material);
  }
  for (const id of maps) {
    const material = readyByID.get(id);
    if (!material || material.availability !== 'settled' || material.record.kind !== 'source' || material.record.decoding.kind !== 'decoded' || material.record.artifactKey === null) {
      throw new WorkspaceFailure('invalidArtifact');
    }
    const selectionOrigin = input.codemapMode === 'automatic' && input.request.copyPreset.codeMapUsage === 'auto' ? 'inferred' : 'presentation';
    materials.push({ availability: 'settled', bodies: material.bodies, sourceBlock: null, record: { ...material.record, decoding: material.record.decoding, selectionOrigin, required: false,
      selection: { kind: 'codemap', source: material.record.selection.source }, normalized: [], artifactKey: material.record.artifactKey } });
  }
  return materials;
}

function retainRequiredRepresentations(materials: Material[], request: CapturedContextBuildRequest): void {
  for (const selection of request.requiredSources) {
    const material = materials.find(material => material.record.id === sourceId(selection.source));
    if (!material || material.record.kind !== 'source' || material.record.selection.kind !== selection.kind) {
      throw new WorkspaceFailure('copyPresetRequiredMaterialConflict', { copyPreset: request.copyPreset.raw.id, materialId: sourceId(selection.source) });
    }
    if (material.record.selection.kind === 'codemap' && material.record.selectionOrigin === 'presentation') {
      materials[materials.indexOf(material)] = { ...material, record: { ...material.record, selectionOrigin: 'explicit', required: true } };
    }
  }
}

/** Exact preset demand is a presentation lease, separate from canonical and inferred selection. */
export async function withManualPresentation<T>(runtime: MipmuxRuntime, operation: WorkspaceOperation | null, input: Input,
  canonical: CanonicalSelection, signal: AbortSignal,
  complete: (materials: readonly Material[], proof: ManualPresentation, inventory: Input['inventory']) => Promise<T>): Promise<T> {
  const canonicalSources = capturedSourceSelections(input.materials, input.unavailableRoots, input.unavailableFiles);
  const directlySelected = canonicalSources.filter(selection => {
    const root = canonical.roots.find(root => root.name === selection.source.root)!;
    return canonical.state.selectedPaths.includes(posix.join(root.selectionPath, selection.source.path));
  }).map(selection => selection.source);
  const proof: ManualPresentation = { canonicalSources, directlySelected, requested: [], ready: [], completeRootSet: false };
  const plan = await runtime.renderPresentation(manualPlanInput(input, proof), signal);
  const includeFiles = plan.preset.includeFiles;
  proof.requested = sourcesForIDs(input.inventory, plan.fileIDs); proof.completeRootSet = plan.completeRootSet;
  const finish = async (readyMaterials: readonly Material[]) => {
    proof.ready = readyMaterials.flatMap(material => material.record.kind === 'source' && material.record.selection.kind === 'codemap' &&
      material.availability === 'settled' && material.bodies.length ? [material.record.selection.source] : []);
    if (plan.intent === 'automatic') {
      const catalog = new Map((operation?.snapshot ?? input.inventory).entries.map(entry => [sourceId(entry), entry]));
      for (const source of proof.requested) if (!input.unavailableRoots.some(root => root.root === source.root) &&
        codemapRepresentation(catalog.get(sourceId(source)), source)?.kind === 'rendered') proof.ready.push(source);
    }
    const inventory = operation?.snapshot ?? input.inventory;
    const final = await runtime.renderPresentation(manualPlanInput({ ...input, inventory }, proof), signal);
    const maps = new Set(sourcesForIDs(inventory, final.codemapFileIDs).map(sourceId));
    const materials = projectMaterials(input, includeFiles, maps, readyMaterials);
    retainRequiredRepresentations(materials, input.request);
    return complete(materials, proof, inventory);
  };
  if (plan.intent === 'none') return finish([]);
  if (input.request.copyPreset.codeMapUsage === 'auto' || operation === null) {
    return finish(input.materials.filter(material => material.record.kind === 'source' && material.record.selection.kind === 'codemap'));
  }
  const pending = new Map<string, Material>();
  const unavailable = new Set(input.unavailableRoots.map(root => root.root));
  const unavailableFiles = new Set(input.unavailableFiles.map(file => file.id));
  const catalog = new Map(operation.snapshot.entries.map(entry => [sourceId(entry), entry]));
  for (const source of proof.requested) {
    if (unavailable.has(source.root) || unavailableFiles.has(sourceId(source))) continue;
    const entry = catalog.get(sourceId(source));
    if (entry?.kind !== 'file' || entry.structural.kind === 'unsupported') continue;
    const material = await prepareCodemapSelection(operation, { kind: 'codemap', source });
    pending.set(material.record.id, material);
  }
  return withCodemapPresentation(operation, 'manual', performance.now(), async () => ({ materials: pending, automaticCodemaps: [] }),
    presentation => finish([...presentation.materials.values()]));
}
