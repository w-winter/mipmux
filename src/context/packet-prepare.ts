import type { ContextBuildRequest, ContextPrepareRequest, Manifest, MaterialRecord } from '../contracts/context.js';
import type { SourcePath } from '../contracts/inventory.js';
import type { RootIdentity } from '../contracts/workspace.js';
import type { MipmuxRuntime } from '../runtime/mipmux-runtime.js';
import type { PolicyDeclaration } from '../workspace/root-policy.js';
import { canonicalJSON, WorkspaceFailure } from '../workspace/values.js';
import { prepareClipboard } from './clipboard.js';
import { renderBundle, type Diagnostic, type Measurement } from './render.js';
import { bundleManifest, publishBundle } from './bundle-publication.js';
import { verifySavedBundle, type VerifiedBundle } from './verify.js';
import { sourceId } from './material-store.js';
import { estimateUnits } from './budget.js';
import { capturedSourceSelections } from './source-omissions.js';
import type { SelectedGitArtifact } from './git-artifact-material.js';

export type PreparedPacket =
  | { readonly kind: 'ready'; readonly directory: string; readonly manifest: Manifest; readonly saved: Manifest }
  | { readonly kind: 'blocked'; readonly diagnostics: readonly Diagnostic[]; readonly measurement: Measurement };

/** Reads and verifies a saved bundle beneath the output root through confined, no-follow native reads. */
export async function readSavedBundle(runtime: MipmuxRuntime, output: RootIdentity, bundle: string, signal: AbortSignal): Promise<VerifiedBundle> {
  const bridge = runtime.makeBridge();
  try {
    const opened = await bridge.request({ kind: 'openRoots', roots: [{ name: 'output', absolutePath: output.declaredPath,
      access: 'source', expected: output }] }, signal);
    const root = opened.result.roots[0];
    if (!root) throw new WorkspaceFailure('nativeProtocolError');
    return await verifySavedBundle(async filename => (await bridge.request({ kind: 'readSource', root: root.handle,
      path: bundle + '/' + filename, expected: null }, signal)).bytes);
  } finally { await bridge.close(); }
}

/** A saved bundle grants no filesystem authority: its roots and output root must be the declaring workspace's. */
export function requireBundleWorkspace(manifest: Manifest, declaration: Pick<PolicyDeclaration, 'roots' | 'outputRoot'>): void {
  const key = (name: string, root: RootIdentity) => [name, root.canonicalPath, root.device, root.inode];
  const saved = [...manifest.inventory.roots.map(root => key(root.name, root.identity)), key('', manifest.inventory.outputRoot)];
  const declared = [...declaration.roots.map(root => key(root.name, root.identity)), key('', declaration.outputRoot)];
  if (canonicalJSON(saved) !== canonicalJSON(declared)) throw new WorkspaceFailure('bundleWorkspaceMismatch');
}

/**
 * Renders the saved evidence, constraints and formatting with the replacement prompt and publishes it as a new bundle in
 * the same output root. `recheck` repeats current verification before the manifest is published. A caller's `budgetUnits`
 * limits the packet; otherwise the saved budget is raised as far as the packet needs, since only the task changed.
 */
export async function publishPreparedPacket(runtime: MipmuxRuntime, saved: VerifiedBundle, request: ContextPrepareRequest,
  signal: AbortSignal, recheck: () => Promise<void>): Promise<PreparedPacket> {
  const manifest = saved.verified.manifest;
  const clipboard = await prepareClipboard(runtime, { request: { ...manifest.request, outputName: request.outputName },
    prompt: request.prompt, manualPresentation: manifest.manualPresentation, inventory: manifest.inventory,
    codemapMode: manifest.codemapMode, materials: saved.materials, fileTree: saved.fileTree,
    unavailableRoots: manifest.unavailableRoots, unavailableFiles: manifest.unavailableFiles,
    automaticAcquisition: { kind: 'settled', outcomes: manifest.automaticCodemaps } }, signal,
  { kind: 'captured', capture: saved.automaticGit });
  // A published bundle must fit its recorded allowance, which verification re-renders against.
  const budgetUnits = request.budgetUnits ??
    Math.max(manifest.request.budgetUnits, estimateUnits(Buffer.byteLength(clipboard.clipboard)));
  const input = { ...clipboard, request: { ...clipboard.request, budgetUnits } };
  const rendered = renderBundle(input);
  // A preset that omits user instructions would publish a packet without the task the caller supplied.
  const diagnostics: readonly Diagnostic[] = request.prompt !== '' && !input.clipboardPreset.includeUserPrompt
    ? [...rendered.diagnostics, { code: 'promptExcluded', materialId: null, details: {} }] : rendered.diagnostics;
  if (diagnostics.length) return { kind: 'blocked', diagnostics, measurement: rendered.measurement };
  const prepared = bundleManifest(input, rendered, manifest.automaticCodemaps, manifest);
  const bridge = runtime.makeBridge();
  try {
    const directory = await publishBundle(bridge, manifest.inventory.outputRoot, request.outputName, rendered, prepared,
      signal, recheck, () => {});
    return { kind: 'ready', directory, manifest: prepared, saved: manifest };
  } finally { await bridge.close(); }
}

// Root names begin with a letter, so a source path never equals a Git artifact alias, which begins with `_git_data/`.
function sourcePath(source: SourcePath): string { return source.root + '/' + source.path; }

type NamedMaterial = Extract<MaterialRecord, { kind: 'source' | 'gitMap' | 'gitPatch' }>;

/** How callers name a source or Git artifact material: `root/path` for a source, or the artifact's alias. */
export function materialPath(record: NamedMaterial): string {
  return record.kind === 'source' ? sourcePath(record.selection.source) : record.reference.alias;
}

/** Saved sources (by source ID) and Git artifacts (by alias) that a preparation removes or demotes. */
export interface SelectionEdits {
  readonly removedSources: ReadonlySet<string>;
  readonly demotedSources: ReadonlySet<string>;
  readonly removedArtifacts: ReadonlySet<string>;
}

type EditOutcome = { readonly kind: 'problem'; readonly reason: string }
  | { readonly kind: 'source'; readonly id: string } | { readonly kind: 'artifact'; readonly alias: string };

function editOutcome(edit: 'remove' | 'demote', record: NamedMaterial | undefined, addedAsRequired: boolean): EditOutcome {
  const problem = (reason: string) => ({ kind: 'problem' as const, reason });
  if (record === undefined) return problem('not a material of the saved bundle');
  if (record.kind !== 'source') {
    return edit === 'remove' ? { kind: 'artifact', alias: record.reference.alias } : problem('Git artifacts cannot be demoted');
  }
  if (record.required || addedAsRequired) return problem('required material');
  if (record.selectionOrigin === 'inferred') return problem('codemap added automatically for a selected file');
  if (record.selectionOrigin === 'presentation') return problem('codemap added by the copy preset');
  if (edit === 'demote' && record.selection.kind === 'codemap') return problem('already a codemap');
  return { kind: 'source', id: sourceId(record.selection.source) };
}

/**
 * Resolves `remove` and `demote` paths against the saved bundle's delivered materials. Removal accepts optional sources
 * the selection names directly and selected Git artifacts; demotion accepts optional full files and slices. Required
 * material, including sources this request adds as required, stays fixed. Every problem is reported together.
 */
export function selectionEdits(saved: VerifiedBundle, request: ContextPrepareRequest): SelectionEdits {
  const records = new Map(saved.verified.manifest.materials.flatMap(record =>
    record.kind === 'document' || record.kind === 'patch' ? [] : [[materialPath(record), record] as const]));
  const added = new Set((request.requiredSources ?? []).map(selection => sourcePath(selection.source)));
  const requested = [...(request.remove ?? []).map(path => ({ edit: 'remove' as const, path })),
    ...(request.demote ?? []).map(path => ({ edit: 'demote' as const, path }))];
  const paths = requested.map(item => item.path);
  const outcomes = requested.map(({ edit, path }, index) => ({ edit, path, outcome: paths.indexOf(path) === index
    ? editOutcome(edit, records.get(path), added.has(path)) : { kind: 'problem' as const, reason: 'named more than once' } }));
  const problems = outcomes.flatMap(({ path, outcome }) => outcome.kind === 'problem' ? [path + ': ' + outcome.reason] : []);
  if (problems.length) throw new WorkspaceFailure('invalidSelection', { message: problems.join('; ') });
  const sources = (edit: 'remove' | 'demote') =>
    new Set(outcomes.flatMap(item => item.edit === edit && item.outcome.kind === 'source' ? [item.outcome.id] : []));
  return { removedSources: sources('remove'), demotedSources: sources('demote'),
    removedArtifacts: new Set(outcomes.flatMap(({ outcome }) => outcome.kind === 'artifact' ? [outcome.alias] : [])) };
}

/** The saved bundle's selected Git snapshot artifacts, in packet order. */
export function savedGitArtifacts(saved: VerifiedBundle): SelectedGitArtifact[] {
  return saved.verified.manifest.materials.flatMap(record => record.kind === 'gitMap' || record.kind === 'gitPatch' ? [record] : []);
}

/**
 * The build request that reacquires a saved bundle's evidence from current files: its captured request, selection and
 * omitted sources, with the caller's edits, budget and added required sources, documents and patches. Selected Git
 * artifacts are adopted separately.
 */
export function rebuildRequest(saved: VerifiedBundle, request: ContextPrepareRequest, edits: SelectionEdits): ContextBuildRequest {
  const manifest = saved.verified.manifest;
  const { copyContext: _context, copyPreset: _preset, copyPresetSelector, clarification: _clarification, ...captured } = manifest.request;
  const requiredSources = [...captured.requiredSources, ...request.requiredSources ?? []];
  const required = new Set(requiredSources.map(selection => sourceId(selection.source)));
  const sources = (manifest.manualPresentation?.canonicalSources ??
    capturedSourceSelections(saved.materials, manifest.unavailableRoots, manifest.unavailableFiles))
    .filter(selection => !required.has(sourceId(selection.source)) && !edits.removedSources.has(sourceId(selection.source)))
    .map(selection => edits.demotedSources.has(sourceId(selection.source)) ? { kind: 'codemap' as const, source: selection.source } : selection);
  // Automatic mode re-derives its codemaps from the rebuilt selection, so a demotion drops only those that the demoted
  // file alone referenced.
  return { ...captured, copyPreset: copyPresetSelector, outputName: request.outputName, requiredSources,
    budgetUnits: request.budgetUnits ?? captured.budgetUnits,
    documents: [...captured.documents, ...request.documents ?? []], patches: [...captured.patches, ...request.patches ?? []],
    initialSelection: { codemapMode: manifest.codemapMode, sources } };
}
