import type { CodemapMode, CapturedContextBuildRequest, Manifest } from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { renderBundle } from './render.js';
import { bundleManifest, publishBundle } from './bundle-publication.js';
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
      const { automaticAcquisition } = input;
      if (automaticAcquisition.kind === 'pending' || rendered.diagnostics.length) {
        return {
          kind: 'blocked',
          revision,
          diagnostics: rendered.diagnostics,
          measurement: rendered.measurement,
          costs: rendered.costs,
        };
      }
      const manifest = bundleManifest(input, rendered, automaticAcquisition.outcomes, owner.declaration);
      const directory = await publishBundle(bridge, owner.snapshot.outputRoot, request.outputName, rendered, manifest, signal,
        () => revalidatePacket(operation, input), () => { this.#claimed = true; this.publishing(); });
      return { kind: 'ready', directory, manifest };
    } finally {
      await bridge.close();
      await operation.close();
    }
  }
}
