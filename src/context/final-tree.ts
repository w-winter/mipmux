import type { CodemapMode, UnavailableFile, UnavailableRoot } from '../contracts/context.js';
import type { InventorySnapshot } from '../contracts/inventory.js';
import type { NativeOperation } from '../contracts/native.js';
import type { SmipRuntime } from '../runtime/smip-runtime.js';
import type { Material } from './material-store.js';
import { sourceId } from './material-store.js';
import type { RenderInput } from './render.js';
import { prepareClipboard } from './clipboard.js';
import type { AutomaticReviewGitSource } from './automatic-review-git.js';

type TreeInput = Extract<NativeOperation, { kind: 'renderFileTree' }>;
export interface FinalFileTree {
  readonly input: TreeInput;
  readonly text: string;
}

/** Captures final-export selection and operation-specific codemap availability in the admitted view. */
export function finalFileTreeInput(inventory: Omit<InventorySnapshot, 'generation'>,
  materials: readonly Material[], mode: CodemapMode, unavailableRoots: readonly UnavailableRoot[], unavailableFiles: readonly UnavailableFile[]): TreeInput {
  const selected = new Set<string>(), available = new Set<string>();
  const unavailable = new Set(unavailableRoots.map(root => root.root));
  for (const root of unavailableRoots) for (const source of root.sources) if (source.selection.kind !== 'codemap') selected.add(source.id);
  for (const source of unavailableFiles) selected.add(source.id);
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

export async function renderFinalFileTree(runtime: SmipRuntime, inventory: Omit<InventorySnapshot, 'generation'>,
  materials: readonly Material[], mode: CodemapMode, unavailableRoots: readonly UnavailableRoot[], unavailableFiles: readonly UnavailableFile[], signal: AbortSignal): Promise<FinalFileTree> {
  const input = finalFileTreeInput(inventory, materials, mode, unavailableRoots, unavailableFiles);
  const result = await runtime.renderPresentation(input, signal);
  return { input, text: result.tree };
}

export async function prepareRenderInput(runtime: SmipRuntime, input: Omit<RenderInput, 'fileTree' | 'clipboard' | 'clipboardPreset' | 'selectedGitDiffIds' | 'automaticGit' | 'tokenInputs'>,
  signal: AbortSignal, gitSource: AutomaticReviewGitSource): Promise<RenderInput> {
  const fileTree = await renderFinalFileTree(runtime, input.inventory, input.materials, input.codemapMode, input.unavailableRoots, input.unavailableFiles, signal);
  return prepareClipboard(runtime, { ...input, fileTree }, signal, gitSource);
}
