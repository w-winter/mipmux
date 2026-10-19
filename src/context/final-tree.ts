import type { CodemapMode, UnavailableFile, UnavailableRoot } from '../contracts/context.js';
import type { InventorySnapshot } from '../contracts/inventory.js';
import type { NativeOperation } from '../contracts/native.js';
import type { SmipRuntime } from '../runtime/smip-runtime.js';
import type { Material } from './material-store.js';
import { sourceId } from './material-store.js';
import type { RenderInput } from './render.js';
import { prepareClipboard } from './clipboard.js';
import type { AutomaticReviewGitSource } from './automatic-review-git.js';
import type { CanonicalSelection } from './selection-preparation.js';
import { withManualPresentation } from './manual-presentation.js';
import { assertClipboardRequiredMaterials } from './clipboard-selection.js';
import { usesPresetPresentation, type CapturedClipboardPreset } from '../contracts/presentation.js';
import type { ManualPresentation } from '../contracts/context.js';

type TreeInput = Extract<NativeOperation, { kind: 'renderFileTree' }>;
type FileTreeCapture = Pick<RenderInput, 'request' | 'inventory' | 'materials' | 'codemapMode' | 'unavailableRoots' | 'unavailableFiles' | 'manualPresentation'>;
export interface FinalFileTree {
  readonly input: TreeInput | null;
  readonly text: string;
}

/** Captures final-export selection and operation-specific codemap availability in the admitted view. */
export function finalFileTreeInput(inventory: Omit<InventorySnapshot, 'generation'>,
  materials: readonly Material[], mode: CodemapMode, unavailableRoots: readonly UnavailableRoot[], unavailableFiles: readonly UnavailableFile[]): TreeInput {
  const selected = new Set<string>(), available = new Set<string>();
  const unavailable = new Set(unavailableRoots.map(root => root.root));
  for (const root of unavailableRoots) for (const source of root.sources) if (source.selection.kind !== 'codemap') selected.add(source.id);
  for (const source of unavailableFiles) if (source.selection.kind !== 'codemap') selected.add(source.id);
  for (const material of materials) {
    const record = material.record;
    if (record.kind === 'document' && record.input.kind === 'localDocument') selected.add(sourceId(record.input.source));
    if (record.kind !== 'source') continue;
    if (record.selection.kind !== 'codemap' || mode === 'automatic') selected.add(record.id);
    if (record.selection.kind === 'codemap' && material.availability === 'settled' && material.bodies.length) available.add(record.id);
  }
  const entries = inventory.entries.flatMap<TreeInput['entries'][number]>(entry => {
    if (entry.kind === 'directory') {
      if (entry.visibility === 'managedOnly') return [];
      return [{ kind: 'directory', root: entry.root, path: entry.path }];
    }
    if (entry.kind !== 'file' && entry.kind !== 'acquisitionFailed') return [];
    const id = sourceId(entry);
    if (entry.kind === 'file' && entry.visibility === 'managedOnly' && !selected.has(id) && !available.has(id)) return [];
    const projected = entry.kind === 'file' && entry.structural.kind === 'artifact' &&
      entry.structural.record.outcome.kind === 'ready' && entry.structural.record.projection !== undefined;
    return [{ kind: 'file', root: entry.root, path: entry.path, selected: selected.has(id),
      hasCodeMap: available.has(id) || mode === 'automatic' && selected.has(id) && projected && !unavailable.has(entry.root) }];
  });
  return { kind: 'renderFileTree', roots: inventory.roots.map(root => ({ name: root.name, path: root.name })), entries,
    scope: null, mode: 'auto', maxDepth: null, includeLegend: true, showFullPaths: false,
    onlyIncludeRootsWithSelectedFiles: true, showCodeMapMarkers: true };
}

function manualTreeSelections(input: FileTreeCapture, proof: ManualPresentation, preset: CapturedClipboardPreset): Set<string> {
  const selected = new Set(proof.canonicalSources.filter(source => source.kind !== 'codemap').map(source => sourceId(source.source)));
  for (const { record } of input.materials) {
    if (record.kind === 'document' && record.input.kind === 'localDocument') selected.add(sourceId(record.input.source));
    if (record.kind === 'source' && record.selection.kind === 'codemap' && preset.codeMapUsage === 'auto' && input.codemapMode === 'automatic') selected.add(record.id);
  }
  return selected;
}

export function capturedFileTreeInput(input: FileTreeCapture): TreeInput | null {
  const tree = finalFileTreeInput(input.inventory, input.materials, input.codemapMode, input.unavailableRoots, input.unavailableFiles);
  const preset = input.request.copyPreset, proof = input.manualPresentation;
  if (!usesPresetPresentation(preset)) return tree;
  if (proof === null) throw new Error('Captured presentation proof required');
  const mode = preset.fileTreeMode;
  if (!preset.includeFileTree || mode === 'None') return null;
  const selected = manualTreeSelections(input, proof, preset);
  const ready = new Set(proof.ready.map(sourceId));
  for (const entry of tree.entries) if (entry.kind === 'file') {
    entry.selected = selected.has(sourceId(entry));
    entry.hasCodeMap = !input.request.copyContext.codeMapsGloballyDisabled && ready.has(sourceId(entry));
  }
  tree.showCodeMapMarkers = !input.request.copyContext.codeMapsGloballyDisabled;
  tree.mode = mode === 'Full' ? 'full' : mode === 'Selected' ? 'selected' : 'auto';
  return tree;
}

export async function prepareRenderInput(runtime: SmipRuntime, input: Omit<RenderInput, 'fileTree' | 'clipboard' | 'clipboardPreset' | 'selectedGitDiffIds' | 'automaticGit' | 'tokenInputs' | 'manualPresentation'>,
  signal: AbortSignal, gitSource: AutomaticReviewGitSource, canonical: CanonicalSelection): Promise<RenderInput> {
  assertClipboardRequiredMaterials(input.request, input.materials);
  const preset = input.request.copyPreset;
  if (!usesPresetPresentation(preset)) {
    const treeInput = finalFileTreeInput(input.inventory, input.materials, input.codemapMode, input.unavailableRoots, input.unavailableFiles);
    const fileTree = { input: treeInput, text: (await runtime.renderPresentation(treeInput, signal)).tree };
    return prepareClipboard(runtime, { ...input, manualPresentation: null, fileTree }, signal, gitSource);
  }
  return withManualPresentation(runtime, gitSource.kind === 'live' ? gitSource.operation : null, input, canonical, signal, async (materials, manualPresentation, inventory) => {
    const treeInput = capturedFileTreeInput({ ...input, inventory, materials, manualPresentation });
    const fileTree = treeInput === null ? { input: null, text: '' }
      : { input: treeInput, text: (await runtime.renderPresentation(treeInput, signal)).tree };
    return prepareClipboard(runtime, { ...input, materials, inventory, manualPresentation, fileTree,
      automaticAcquisition: input.codemapMode === 'automatic' && preset.codeMapUsage === 'auto'
        ? input.automaticAcquisition : { kind: 'settled', outcomes: [] } }, signal, gitSource);
  });
}
