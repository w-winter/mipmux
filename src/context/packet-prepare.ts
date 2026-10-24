import type { ContextPrepareRequest, Manifest } from '../contracts/context.js';
import type { RootIdentity } from '../contracts/workspace.js';
import type { MipmuxRuntime } from '../runtime/mipmux-runtime.js';
import type { PolicyDeclaration } from '../workspace/root-policy.js';
import { canonicalJSON, WorkspaceFailure } from '../workspace/values.js';
import { prepareClipboard } from './clipboard.js';
import { renderBundle, type Diagnostic, type Measurement } from './render.js';
import { bundleManifest, publishBundle } from './bundle-publication.js';
import { verifySavedBundle, type VerifiedBundle } from './verify.js';

export type PreparedPacket =
  | { readonly kind: 'ready'; readonly directory: string; readonly manifest: Manifest }
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
    return { kind: 'ready', directory, manifest: prepared };
  } finally { await bridge.close(); }
}
