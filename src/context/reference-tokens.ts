import type { ReferenceTokenStats } from '../contracts/token-accounting.js';
import type { NativeOperation } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { CanonicalSelection } from './selection-preparation.js';
import type { RenderInput } from './render.js';
import { sourceId } from './material-store.js';
import { estimateUnits } from './budget.js';
import { acquireSelectedReviewGit } from './automatic-review-git.js';
import { freeze } from '../workspace/values.js';
import { posix } from 'node:path';

export interface ReferenceTokenView {
  readonly stats: ReferenceTokenStats;
  readonly incompleteComponents: readonly string[];
}

function fileTokens(input: RenderInput) {
  const totals = { fullTokens: 0, sliceTokens: 0, codemapTokens: 0 };
  for (const material of input.materials) {
    const record = material.record;
    if (record.kind === 'gitMap' || record.kind === 'gitPatch') {
      totals.fullTokens += estimateUnits(Buffer.byteLength(material.bodies.join('')));
    } else if (record.kind === 'source' && material.availability === 'settled') {
      const key = record.selection.kind === 'codemap' ? 'codemapTokens' : record.selection.kind === 'slices' ? 'sliceTokens' : 'fullTokens';
      totals[key] += estimateUnits(Buffer.byteLength(material.bodies.join('')));
    }
  }
  return totals;
}

function tokenTreeInput(input: RenderInput, selectedPaths: ReadonlySet<string>): Extract<NativeOperation, { kind: 'renderFileTree' }> {
  const maps = new Set(input.materials.flatMap(material => material.record.kind === 'source' &&
    material.record.selection.kind === 'codemap' && material.availability === 'settled' && material.bodies.length ? [material.record.id] : []));
  const roots = new Map(input.inventory.roots.map(root => [root.name, root.identity.canonicalPath]));
  const entries = input.inventory.entries.flatMap<Extract<NativeOperation, { kind: 'renderFileTree' }>['entries'][number]>(entry => {
    if (entry.kind === 'directory') return entry.visibility === 'discoverable' ? [{ kind: 'directory', root: entry.root, path: entry.path }] : [];
    if (entry.kind !== 'file' && entry.kind !== 'acquisitionFailed') return [];
    const selected = selectedPaths.has(posix.join(roots.get(entry.root)!, entry.path)), hasCodeMap = maps.has(sourceId(entry));
    if (entry.kind === 'file' && entry.visibility === 'managedOnly' && !selected && !hasCodeMap) return [];
    return [{ kind: 'file', root: entry.root, path: entry.path, selected, hasCodeMap }];
  });
  return { kind: 'renderFileTree', roots: input.inventory.roots.map(root => ({ name: root.name, path: root.name })), entries,
    scope: null, mode: 'auto', maxDepth: null, includeLegend: true, showFullPaths: false,
    onlyIncludeRootsWithSelectedFiles: true, showCodeMapMarkers: true };
}

/** File totals use the proposed presentation; tree and Git use the captured canonical selection, including during preview. */
export async function captureReferenceTokens(operation: WorkspaceOperation, input: RenderInput, canonical: CanonicalSelection): Promise<ReferenceTokenView> {
  const paths = [...new Set([...canonical.state.selectedPaths, ...Object.entries(canonical.state.slices)
    .filter(([, ranges]) => ranges.length).map(([path]) => path)])];
  const selectedPaths = new Set(paths);
  const tree = await operation.runtime.renderPresentation(tokenTreeInput(input, selectedPaths), operation.signal);
  let gitText: string | null = null;
  if (input.clipboardPreset.gitInclusion === 'selected') {
    const roots = new Map(input.inventory.roots.map(root => [root.name, root.identity.canonicalPath]));
    const candidates = input.inventory.entries.filter(entry => entry.kind === 'file' && selectedPaths.has(posix.join(roots.get(entry.root)!, entry.path)));
    const availableRoots = new Set<string>();
    for (const root of new Set(candidates.map(entry => entry.root))) {
      if ((await operation.sourceRootAvailability(root)).kind === 'available') availableRoots.add(root);
    }
    const files = new Set(candidates.filter(entry => availableRoots.has(entry.root)).map(entry => posix.join(roots.get(entry.root)!, entry.path)));
    const git = await acquireSelectedReviewGit(operation, input.request, { paths: paths.filter(path => files.has(path)),
      unresolvedCandidates: paths.filter(path => !files.has(path)) });
    gitText = git.text;
  }
  const result = await operation.runtime.renderPresentation({ kind: 'calculateTokenStats', files: fileTokens(input),
    ...input.tokenInputs, fileTreeText: tree.tree, gitDiffText: gitText, metadataText: null,
    duplicateUserInstructionsAtTop: input.request.duplicateUserInstructionsAtTop }, operation.signal);
  const pending = input.automaticAcquisition.kind === 'pending' || input.materials.some(material => material.availability === 'pendingCodemap');
  const omitted = [...input.unavailableRoots.flatMap(root => root.sources), ...input.unavailableFiles];
  const incompleteComponents: string[] = [];
  if (omitted.some(source => source.selection.kind !== 'codemap')) incompleteComponents.push('files');
  if (pending || omitted.some(source => source.selection.kind === 'codemap')) incompleteComponents.push('codemap_presentation');
  return freeze({ stats: result.tokenStats, incompleteComponents });
}

export function referenceTokenFields(view: ReferenceTokenView | null) {
  if (view === null) return { token_stats: null,
    token_accounting: { source: 'captured_draft', status: 'unavailable', refresh_pending: false, incomplete_components: ['unobserved'] } } as const;
  return { token_stats: view.stats,
    token_accounting: { source: 'captured_draft', status: view.incompleteComponents.length ? 'incomplete' : 'captured',
      refresh_pending: false, incomplete_components: view.incompleteComponents } } as const;
}
