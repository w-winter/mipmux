import type { ContextBuildRequest, ContextPrepareRequest, Manifest, SourceSelection } from '../contracts/context.js';
import type { RootIdentity } from '../contracts/workspace.js';
import type { MipmuxRuntime } from '../runtime/mipmux-runtime.js';
import type { PolicyDeclaration } from '../workspace/root-policy.js';
import { canonicalJSON, WorkspaceFailure } from '../workspace/values.js';
import { prepareClipboard } from './clipboard.js';
import { renderBundle, type Diagnostic, type Measurement } from './render.js';
import { bundleManifest, publishBundle } from './bundle-publication.js';
import { verifySavedBundle, type VerifiedBundle } from './verify.js';
import { sourceId } from './material-store.js';
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
 * Renders the saved evidence, constraints, formatting and budget with the replacement prompt and publishes it as a
 * new bundle in the same output root. `recheck` repeats current verification before the manifest is published.
 */
export async function publishPreparedPacket(runtime: MipmuxRuntime, saved: VerifiedBundle, request: ContextPrepareRequest,
  signal: AbortSignal, recheck: () => Promise<void>): Promise<PreparedPacket> {
  const manifest = saved.verified.manifest;
  const input = await prepareClipboard(runtime, { request: { ...manifest.request, outputName: request.outputName },
    prompt: request.prompt, manualPresentation: manifest.manualPresentation, inventory: manifest.inventory,
    codemapMode: manifest.codemapMode, materials: saved.materials, fileTree: saved.fileTree,
    unavailableRoots: manifest.unavailableRoots, unavailableFiles: manifest.unavailableFiles,
    automaticAcquisition: { kind: 'settled', outcomes: manifest.automaticCodemaps } }, signal,
  { kind: 'captured', capture: saved.automaticGit });
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

/** The saved bundle's selected Git snapshot artifacts, in packet order. */
export function savedGitArtifacts(saved: VerifiedBundle): SelectedGitArtifact[] {
  return saved.verified.manifest.materials.flatMap(record => record.kind === 'gitMap' || record.kind === 'gitPatch' ? [record] : []);
}

/**
 * The build request that reacquires a saved bundle's evidence from current files: its captured request, selection and
 * omitted sources, plus the caller's added required sources, documents and patches. Selected Git artifacts are adopted separately.
 */
export function rebuildRequest(saved: VerifiedBundle, request: ContextPrepareRequest): ContextBuildRequest {
  const manifest = saved.verified.manifest;
  const { copyContext: _context, copyPreset: _preset, copyPresetSelector, clarification: _clarification, ...captured } = manifest.request;
  const requiredSources = [...captured.requiredSources, ...request.requiredSources ?? []];
  const required = new Set(requiredSources.map(selection => sourceId(selection.source)));
  const sources = (manifest.manualPresentation?.canonicalSources ??
    capturedSourceSelections(saved.materials, manifest.unavailableRoots, manifest.unavailableFiles))
    .filter(selection => !required.has(sourceId(selection.source)));
  return { ...captured, copyPreset: copyPresetSelector, outputName: request.outputName, requiredSources,
    documents: [...captured.documents, ...request.documents ?? []], patches: [...captured.patches, ...request.patches ?? []],
    // Automatic mode derives codemaps itself; only explicit full and sliced sources seed it.
    initialSelection: manifest.codemapMode === 'automatic' ? { codemapMode: 'automatic', sources: sources.filter(isFileContent) }
      : { codemapMode: 'manual', sources } };
}

function isFileContent(selection: SourceSelection): selection is Exclude<SourceSelection, { kind: 'codemap' }> {
  return selection.kind !== 'codemap';
}
