import { join } from 'node:path';
import type { CodemapMode, CapturedContextBuildRequest, Manifest } from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { canonicalJSON, sha256, WorkspaceFailure } from '../workspace/values.js';
import { identity } from './material-store.js';
import { renderBundle } from './render.js';
import { NativeFailure, NativeWorkerFailure } from '../native/bridge-client.js';
import type { CodemapPresentation } from './codemap-readiness.js';
import type { DerivedMaterials } from './automatic-codemap-acquisition.js';
import { captureReferenceTokens, type ReferenceTokenView } from './reference-tokens.js';
import type { CanonicalSelection } from './selection-preparation.js';
import { assemblePacket, initialPacketCapture, revalidatePacket, type PacketCapture } from './packet-assembly.js';

export type FinalizationResult =
  | { readonly kind: 'ready'; readonly directory: string; readonly manifest: Manifest }
  | {
    readonly kind: 'blocked';
    readonly revision: number;
    readonly diagnostics: ReturnType<typeof renderBundle>['diagnostics'];
    readonly measurement: ReturnType<typeof renderBundle>['measurement'];
    readonly costs: ReturnType<typeof renderBundle>['costs'];
  };

export type FinalizationCapture = Readonly<PacketCapture & { referenceTokens: ReferenceTokenView | null }>;

/** Owns one publication claim. Cancellation after the claim cannot revoke a durable write. */
export class FinalizationOperation {
  readonly #cancel = new AbortController();
  #claimed = false;
  #capture: PacketCapture & { referenceTokens: ReferenceTokenView | null };
  readonly result: Promise<FinalizationResult>;
  /** Materials and acquisition state advance together; the returned material map is a copy. */
  get captured(): FinalizationCapture {
    return { ...this.#capture, presentation: { materials: new Map(this.#capture.presentation.materials),
      automaticAcquisition: this.#capture.presentation.automaticAcquisition } };
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
    this.#capture = { ...initialPacketCapture(operation.snapshot, initial), referenceTokens: null };
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
    this.#capture.inventory = operation.snapshot;
    const bridge = owner.runtime.makeBridge();
    try {
      const { input, rendered } = await assemblePacket(operation, { request, prompt, mode: codemapMode, canonical,
        presentation: this.#capture.presentation, prepare }, this.#capture, async input => {
        this.#capture.referenceTokens = await captureReferenceTokens(operation, input, canonical);
        return { input, rendered: renderBundle(input) };
      });
      const { materials, automaticAcquisition, inventory } = input;
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
        schemaVersion: 25,
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
      await revalidatePacket(operation, input);
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
