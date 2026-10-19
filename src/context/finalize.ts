import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { CodemapMode, CapturedContextBuildRequest, Manifest, UnavailableFile, UnavailableRoot } from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { InventorySnapshot } from '../contracts/inventory.js';
import { canonicalJSON, freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
import { identity } from './material-store.js';
import { renderBundle, type RenderInput } from './render.js';
import { prepareRenderInput } from './final-tree.js';
import { revalidateMaterials } from './revalidate.js';
import { NativeFailure, NativeWorkerFailure } from '../native/bridge-client.js';
import { refreshGitArtifactMaterials } from './git-artifact-material.js';
import { withCodemapPresentation, type CodemapPresentation } from './codemap-readiness.js';
import type { DerivedMaterials } from './automatic-codemap-acquisition.js';
import { revalidateCapturedAutomaticReviewGit, type AutomaticReviewGitCapture } from './automatic-review-git.js';
import { captureReferenceTokens, type ReferenceTokenView } from './reference-tokens.js';
import type { CanonicalSelection } from './selection-preparation.js';
import { captureUnavailableRoots, packetSources } from './source-omissions.js';

export type FinalizationResult =
  | { readonly kind: 'ready'; readonly directory: string; readonly manifest: Manifest }
  | {
    readonly kind: 'blocked';
    readonly revision: number;
    readonly diagnostics: ReturnType<typeof renderBundle>['diagnostics'];
    readonly measurement: ReturnType<typeof renderBundle>['measurement'];
    readonly costs: ReturnType<typeof renderBundle>['costs'];
  };

/** Owns one publication claim. Cancellation after the claim cannot revoke a durable write. */
export class FinalizationOperation {
  readonly #cancel = new AbortController();
  #claimed = false;
  #capturedPresentation: CodemapPresentation;
  #capturedInventory: InventorySnapshot;
  get capturedInventory(): InventorySnapshot { return this.#capturedInventory; }
  #capturedUnavailableRoots: readonly UnavailableRoot[] = [];
  get capturedUnavailableRoots(): readonly UnavailableRoot[] { return this.#capturedUnavailableRoots; }
  #capturedUnavailableFiles: readonly UnavailableFile[] = [];
  get capturedUnavailableFiles(): readonly UnavailableFile[] { return this.#capturedUnavailableFiles; }
  #capturedReferenceTokens: ReferenceTokenView | null = null;
  get capturedReferenceTokens(): ReferenceTokenView | null { return this.#capturedReferenceTokens; }
  #capturedAutomaticGit: AutomaticReviewGitCapture | null = null;
  get capturedAutomaticGit(): AutomaticReviewGitCapture | null { return this.#capturedAutomaticGit; }
  readonly result: Promise<FinalizationResult>;
  #capturedRenderInput: RenderInput | null = null;
  get capturedRenderInput(): RenderInput {
    if (this.#capturedRenderInput === null) throw new WorkspaceFailure('materialUnavailable');
    return this.#capturedRenderInput;
  }
  /** Materials and acquisition state advance together; the returned material map is a copy. */
  get capturedPresentation(): CodemapPresentation {
    return { materials: new Map(this.#capturedPresentation.materials), automaticAcquisition: this.#capturedPresentation.automaticAcquisition };
  }
  constructor(
    operation: WorkspaceOperation,
    request: CapturedContextBuildRequest,
    codemapMode: CodemapMode,
    prompt: string,
    canonical: CanonicalSelection,
    initial: CodemapPresentation,
    prepare: (operation: WorkspaceOperation, unavailableRoots: ReadonlySet<string>) => Promise<DerivedMaterials>,
    revision: number,
    signal: AbortSignal,
    private readonly publishing: () => void = () => {},
  ) {
    this.#capturedPresentation = { materials: new Map(initial.materials), automaticAcquisition: freeze(initial.automaticAcquisition) };
    this.#capturedInventory = operation.snapshot;
    this.result = this.#run(
      operation,
      request,
      codemapMode,
      prompt,
      canonical,
      prepare,
      revision,
      AbortSignal.any([signal, this.#cancel.signal, operation.signal]),
    );
  }
  cancel(): { kind: 'cancelling' | 'publicationInProgress' } {
    if (this.#claimed) return { kind: 'publicationInProgress' };
    this.#cancel.abort();
    return { kind: 'cancelling' };
  }
  async #run(
    owner: WorkspaceOperation,
    request: CapturedContextBuildRequest,
    codemapMode: CodemapMode,
    prompt: string,
    canonical: CanonicalSelection,
    prepare: (operation: WorkspaceOperation, unavailableRoots: ReadonlySet<string>) => Promise<DerivedMaterials>,
    revision: number,
    signal: AbortSignal,
  ): Promise<FinalizationResult> {
    signal.throwIfAborted();
    const operation = await owner.fork(signal);
    this.#capturedInventory = operation.snapshot;
    const bridge = owner.runtime.makeBridge();
    try {
      const rootFailures = await captureUnavailableRoots(operation);
      const unavailableRoots = new Set(rootFailures.map(root => root.root));
      const assemble = async (presentation: CodemapPresentation) => {
        const captured = await refreshGitArtifactMaterials(operation, [...presentation.materials.values()]);
        const automaticAcquisition = presentation.automaticAcquisition;
        this.#capturedPresentation = { materials: new Map(captured.map(material => [material.record.id, material])),
          automaticAcquisition: freeze(automaticAcquisition) };
        const delivery = await packetSources(operation, captured, rootFailures), materials = delivery.materials;
        this.#capturedUnavailableRoots = delivery.unavailableRoots;
        this.#capturedUnavailableFiles = delivery.unavailableFiles;
        await revalidateMaterials(operation, materials, delivery.unavailableRoots, delivery.unavailableFiles);
        this.#capturedInventory = operation.snapshot;
        const { generation, ...inventory } = this.#capturedInventory;
        const input = await prepareRenderInput(owner.runtime, { request, prompt, codemapMode, materials, inventory, automaticAcquisition,
          unavailableRoots: delivery.unavailableRoots, unavailableFiles: delivery.unavailableFiles }, signal,
          { kind: 'live', operation }, canonical);
        this.#capturedRenderInput = input;
        this.#capturedInventory = operation.snapshot;
        this.#capturedAutomaticGit = input.automaticGit;
        this.#capturedReferenceTokens = await captureReferenceTokens(operation, input, canonical);
        return { materials: input.materials, automaticAcquisition: input.automaticAcquisition, inventory: input.inventory, input, rendered: renderBundle(input) };
      };
      const candidate = request.copyPreset.codeMapUsage !== 'auto' ? await assemble(this.#capturedPresentation)
        : await withCodemapPresentation(operation, codemapMode, performance.now(), () => prepare(operation, unavailableRoots), assemble);
      const { materials, automaticAcquisition, inventory, input, rendered } = candidate;
      if (automaticAcquisition.kind === 'pending' || rendered.diagnostics.length) {
        return {
          kind: 'blocked',
          revision,
          diagnostics: rendered.diagnostics,
          measurement: rendered.measurement,
          costs: rendered.costs,
        };
      }
      const manifest: Manifest = {
        schemaVersion: 23,
        manualPresentation: input.manualPresentation,
        codemapMode,
        automaticCodemaps: [...automaticAcquisition.outcomes],
        request,
        requestDigest: sha256(canonicalJSON(request)),
        inventory,
        exclusions: [...owner.declaration.exclusions],
        deniedAbsolutePaths: [...owner.declaration.deniedAbsolutePaths],
        prompt,
        materials: rendered.records,
        excludedSources: [...input.excludedSources],
        unavailableRoots: [...input.unavailableRoots],
        unavailableFiles: [...input.unavailableFiles],
        clipboardPreset: input.clipboardPreset,
        automaticGit: input.automaticGit === null ? null : { evidence: input.automaticGit.evidence, span: rendered.automaticGitSpan },
        fileTree: { input: input.fileTree.input, span: rendered.fileTreeSpan },
        files: { context: identity(rendered.context), handoff: identity(rendered.handoff) },
        accounting: {
          recipient: 'context.md',
          method: 'utf8-21-over-80-v1',
          bytes: rendered.measurement.bytes,
          units: rendered.measurement.units,
          allowance: rendered.measurement.allowance,
          limitation: 'Heuristic estimate; not an exact token count or provider acceptance guarantee.',
        },
        checks: [
          'source-and-policy-revalidation',
          'complete-delivered-materials',
          'required-source-preservation',
          'explicit-source-omissions',
          'exact-body-spans',
          'actual-packet-accounting',
          'complete-readback',
          'final-input-revalidation',
        ],
        decoder: inventory.decoderPolicy,
      };
      const output = owner.snapshot.outputRoot;
      const opened = await bridge.request({
        kind: 'openRoots',
        roots: [{ name: 'output', access: 'output', absolutePath: output.declaredPath, expected: output }],
      }, signal);
      if (!opened.result.roots[0]) {
        throw new WorkspaceFailure('nativeProtocolError');
      }
      const run = await bridge.request({
        kind: 'beginExport',
        root: opened.result.roots[0].handle,
        name: request.outputName,
      }, signal);
      for (const [filename, text] of [['context.md', rendered.context], ['handoff.md', rendered.handoff]] as const) {
        const bytes = Buffer.from(text);
        await bridge.request(
          { kind: 'writeExport', run: run.result.run, filename, bytes: bytes.toString('base64') },
          signal,
        );
        const read = await bridge.request({ kind: 'readExport', run: run.result.run, filename }, signal);
        if (!Buffer.from(read.result.bytes, 'base64').equals(bytes)) {
          throw new WorkspaceFailure('readbackFailed');
        }
      }
      await revalidateMaterials(operation, materials, input.unavailableRoots, input.unavailableFiles);
      await revalidateCapturedAutomaticReviewGit(operation, input.automaticGit);
      signal.throwIfAborted();
      this.#claimed = true;
      this.publishing();
      const bytes = Buffer.from(canonicalJSON(manifest) + '\n');
      const published = await bridge.request({
        kind: 'publishManifest',
        run: run.result.run,
        bytes: bytes.toString('base64'),
      }, new AbortController().signal).catch(async error => {
        if (error instanceof NativeWorkerFailure || error instanceof NativeFailure && error.code === 'nativeProtocolError') {
          await bridge.close();
          const receipt = await bridge.closed;
          throw new WorkspaceFailure('publicationUncertain', {
            code: error.code, workerClosed: true, exitCode: receipt.code, signal: receipt.signal,
            spawnFailed: receipt.spawnError !== null,
          });
        }
        throw error;
      });
      if (
        canonicalJSON(published.result.identity) !== canonicalJSON(identity(bytes))
      ) throw new WorkspaceFailure('publicationUncertain');
      return { kind: 'ready', directory: join(output.declaredPath, request.outputName), manifest };
    } finally {
      await bridge.close();
      await operation.close();
    }
  }
}
