import { isAbsolute, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Static } from 'typebox';
import type { CapturedContextBuildRequest, CodemapMode, PromptRequest } from '../contracts/context.js';
import type { NativeSelectionReplyInput } from '../contracts/native.js';
import type { RootIdentity } from '../contracts/workspace.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { CanonicalSelection } from './selection-preparation.js';
import type { DerivedMaterials } from './automatic-codemap-acquisition.js';
import { withCodemapPresentation, type CodemapPresentation } from './codemap-readiness.js';
import { packetSources, captureUnavailableRoots } from './source-omissions.js';
import { refreshGitArtifactMaterials } from './git-artifact-material.js';
import { revalidateMaterials } from './revalidate.js';
import { revalidateCapturedAutomaticReviewGit } from './automatic-review-git.js';
import { prepareRenderInput } from './final-tree.js';
import { renderBundle, type RenderInput } from './render.js';
import { estimateUnits } from './budget.js';
import { canonicalJSON, WorkspaceFailure } from '../workspace/values.js';
import { identity, type Material } from './material-store.js';
import { admitPromptReply, presetDescriptor } from './prompt-presets.js';
import type { ResultEncoding } from '../exploration/output-budget.js';
import { contains } from '../workspace/root-policy.js';

type FileEntry = Static<typeof NativeSelectionReplyInput>['entries'][number];
type FileFields = Omit<Extract<FileEntry, { kind: 'full' }>, 'kind'>;

export function selectionFileEntry(record: Extract<Material['record'], { kind: 'source' }>, fields: FileFields): FileEntry {
  switch (record.selection.kind) {
    case 'codemap': return { ...fields, kind: 'codemap', origin: record.selectionOrigin === 'inferred' ? 'auto' : 'manual' };
    case 'slices': return { ...fields, kind: 'slice', ranges: record.selection.ranges };
    case 'full': return { ...fields, kind: 'full' };
  }
}

interface Capture {
  readonly owner: WorkspaceOperation;
  readonly request: CapturedContextBuildRequest;
  readonly revision: number;
  readonly prompt: string;
  readonly mode: CodemapMode;
  readonly canonical: CanonicalSelection;
  readonly presentation: CodemapPresentation;
  readonly prepare: (operation: WorkspaceOperation, unavailableRoots: ReadonlySet<string>) => Promise<DerivedMaterials>;
}

function destinationPath(path: string, output: RootIdentity): string {
  if (!isAbsolute(path)) return path;
  const root = [output.declaredPath, output.canonicalPath].find(root => contains(root, path));
  if (root === undefined) throw new WorkspaceFailure('pathDenied');
  return relative(root, path);
}

async function fileInfos(operation: WorkspaceOperation, input: RenderInput) {
  if (!input.clipboardPreset.includeFiles) return [];
  const entries: FileEntry[] = input.materials.flatMap(material => {
    const record = material.record;
    if (record.kind === 'gitMap' || record.kind === 'gitPatch') return [{ kind: 'full' as const,
      path: record.reference.alias, rootPath: '_git_data', pathWithinRoot: record.reference.snapshotDir + '/' + record.reference.path,
      tokens: estimateUnits(Buffer.byteLength(material.bodies.join(''))) }];
    if (record.kind !== 'source') return [];
    const source = record.selection.source;
    const fields = { path: input.inventory.roots.length === 1 ? source.path : source.root + '/' + source.path,
      rootPath: source.root, pathWithinRoot: source.path, tokens: estimateUnits(Buffer.byteLength(material.bodies.join(''))) };
    const entry = selectionFileEntry(record, fields);
    if (entry.kind === 'codemap') entry.origin = input.clipboardPreset.codeMapUsage === 'selected' ? 'selected_mode'
      : input.codemapMode === 'automatic' ? 'auto' : 'manual';
    return [entry];
  });
  const reply = await operation.renderSelectionReply({ kind: 'renderSelectionReply', entries, status: 'ok',
    codemapAutoEnabled: input.codemapMode === 'automatic', invalidPaths: [], unmappedPaths: [], pendingPaths: [], blocks: null, view: 'files' });
  return reply.files;
}

export async function exportPrompt(capture: Capture, request: Extract<PromptRequest, { op: 'export' }>, signal: AbortSignal, encode: ResultEncoding) {
  const path = request.path.trim();
  if (!path) throw new WorkspaceFailure('exportPathRequired');
  signal.throwIfAborted();
  let capturedRequest = capture.request;
  if (request.copy_preset !== undefined) {
    const resolved = await capture.owner.runtime.renderPresentation({ kind: 'resolveCopyPreset', context: capturedRequest.copyContext,
      selector: request.copy_preset }, signal);
    if (resolved.hasSelector && resolved.preset === null) throw new WorkspaceFailure('copyPresetNotFound');
    if (resolved.preset !== null) capturedRequest = { ...capturedRequest, copyPreset: resolved.preset, copyPresetSelector: request.copy_preset };
  }
  const operation = await capture.owner.fork(signal), bridge = capture.owner.runtime.makeBridge();
  try {
    const rootFailures = await captureUnavailableRoots(operation), unavailable = new Set(rootFailures.map(root => root.root));
    const assemble = async (presentation: CodemapPresentation) => {
      const materials = await refreshGitArtifactMaterials(operation, [...presentation.materials.values()]);
      const delivery = await packetSources(operation, materials, rootFailures);
      await revalidateMaterials(operation, delivery.materials, delivery.unavailableRoots, delivery.unavailableFiles);
      const { generation: _generation, ...inventory } = operation.snapshot;
      const input = await prepareRenderInput(operation.runtime, { request: capturedRequest, codemapMode: capture.mode,
        prompt: capture.prompt, materials: delivery.materials, inventory, automaticAcquisition: presentation.automaticAcquisition,
        unavailableRoots: delivery.unavailableRoots, unavailableFiles: delivery.unavailableFiles }, operation.signal,
        { kind: 'live', operation }, capture.canonical);
      return { input, rendered: renderBundle(input) };
    };
    const { input, rendered } = capturedRequest.copyPreset.codeMapUsage === 'auto'
      ? await withCodemapPresentation(operation, capture.mode, performance.now(), () => capture.prepare(operation, unavailable), assemble)
      : await assemble(capture.presentation);
    if (!rendered.measurement.complete || rendered.diagnostics.length) {
      throw new WorkspaceFailure('promptExportBlocked', { revision: capture.revision, diagnostics: rendered.diagnostics, measurement: rendered.measurement });
    }
    const files = await fileInfos(operation, input);
    const output = operation.snapshot.outputRoot;
    const destination = destinationPath(path, output);
    const reply = admitPromptReply({ op: 'export' as const, export: { path: destination, bytes: rendered.measurement.bytes,
      tokens: rendered.measurement.units, files, copy_preset: presetDescriptor(input.clipboardPreset.raw) } }, request.maxOutputBytes, encode);
    const opened = await bridge.request({ kind: 'openRoots', roots: [{ name: 'output', access: 'output', absolutePath: output.declaredPath, expected: output }] }, signal);
    const root = opened.result.roots[0];
    if (!root) throw new WorkspaceFailure('nativeProtocolError');
    await revalidateMaterials(operation, input.materials, input.unavailableRoots, input.unavailableFiles);
    await revalidateCapturedAutomaticReviewGit(operation, input.automaticGit);
    signal.throwIfAborted();
    // The synchronous native commit must settle even if cancellation arrives while it writes.
    const written = await bridge.request({ kind: 'writePromptExport', root: root.handle, path: destination,
      bytes: Buffer.from(rendered.context).toString('base64') }, new AbortController().signal);
    if (canonicalJSON(written.result.identity) !== canonicalJSON(identity(rendered.context))) throw new WorkspaceFailure('readbackFailed');
    signal.throwIfAborted();
    return reply;
  } finally { await bridge.close(); await operation.close(); }
}
