import { randomUUID } from 'node:crypto';
import {
  type ContextBuildRequest,
  contextRequestValidator,
  type DraftInspection,
  type DraftUpdate,
  type Handoff,
  inspectionValidator,
  updateValidator,
} from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { canonicalJSON, freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
import { pageResult, serializedBytes, identityEncoding, type ResultEncoding } from '../exploration/output-budget.js';
import { pageOffset } from '../exploration/continuation.js';
import { prepareText } from '../exploration/lines.js';
import {
  acquireDocument,
  acquireSource,
  type Material,
  sourceId,
  strictText,
} from './material-store.js';
import { acquirePatch } from '../patches/patch-input.js';
import { type ItemCost, materialMetadata, renderBundle } from './render.js';
import { revalidateMaterials } from './revalidate.js';
import { resolveAllowance } from './budget.js';
import { FinalizationOperation, type FinalizationResult } from './finalize.js';

type HandoffInspection =
  | { readonly kind: 'handoff'; readonly state: 'unset' }
  | { readonly kind: 'handoff'; readonly state: 'set'; readonly handoff: Handoff };

export class DraftRuntime {
  readonly id = randomUUID();
  readonly #materials = new Map<string, Material>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #cancel = new AbortController();
  #revision = 0;
  #freezeGeneration = 0;
  #handoff: Handoff | null = null;
  #state: 'editable' | 'frozen' | 'terminal' = 'editable';
  #finalization: FinalizationOperation | null = null;
  #finalized: Promise<FinalizationResult> | null = null;
  #closing: Promise<void> | null = null;
  private constructor(
    readonly operation: WorkspaceOperation,
    readonly request: ContextBuildRequest,
    private readonly onClosed: () => void,
  ) {}
  get revision(): number {
    return this.#revision;
  }

  static async acquire(
    operation: WorkspaceOperation,
    input: ContextBuildRequest,
    signal: AbortSignal,
    onClosed: () => void,
  ): Promise<DraftRuntime> {
    if (!contextRequestValidator.Check(input)) throw new WorkspaceFailure('invalidRequest');
    const request = freeze(structuredClone(input));
    strictText(request.task);
    strictText(request.constraints);
    request.discoveryHints.forEach(strictText);
    resolveAllowance(request.allowance);
    if (
      new Set(request.requiredSources.map((selection) => sourceId(selection.source))).size !==
        request.requiredSources.length ||
      new Set(request.documents.map((document) => document.id)).size !== request.documents.length ||
      new Set(request.patches.map((patch) => patch.id)).size !== request.patches.length
    ) throw new WorkspaceFailure('duplicateMaterial');
    const draft = new DraftRuntime(operation, request, onClosed), admission = await operation.fork(signal);
    try {
      for (const selection of request.requiredSources) {
        const material = await acquireSource(admission, selection, true);
        draft.#materials.set(material.record.id, material);
      }
      for (const document of request.documents) {
        const material = await acquireDocument(admission, document);
        draft.#materials.set(material.record.id, material);
      }
      for (const patch of request.patches) {
        const material = await acquirePatch(admission, patch);
        draft.#materials.set(material.record.id, material);
      }
      signal.throwIfAborted();
      return draft;
    } finally {
      await admission.close();
    }
  }
  #check(signal: AbortSignal, revision: number): void {
    if (this.#closing || this.#cancel.signal.aborted || this.operation.signal.aborted || signal.aborted) {
      throw new WorkspaceFailure('cancelled');
    }
    if (this.#state !== 'editable') throw new WorkspaceFailure('draftFrozen');
    if (revision !== this.#revision) throw new WorkspaceFailure('revisionConflict', { revision: this.#revision });
  }
  #track<T>(work: Promise<T>): Promise<T> {
    this.#pending.add(work);
    void work.then(() => this.#pending.delete(work), () => this.#pending.delete(work));
    return work;
  }
  update(input: DraftUpdate, signal: AbortSignal, encode: ResultEncoding = identityEncoding) {
    if (!updateValidator.Check(input)) return Promise.reject(new WorkspaceFailure('invalidRequest'));
    return this.#track(this.#update(structuredClone(input), signal, encode));
  }
  async #update(input: DraftUpdate, signal: AbortSignal, encode: ResultEncoding) {
    this.#check(signal, input.expectedRevision);
    const freezeGeneration = this.#freezeGeneration;
    const mutation = input.mutation;
    let prepared: Material | null = null, id: string | null = null;
    if (mutation.kind !== 'handoff') {
      id = sourceId(mutation.kind === 'upsert' ? mutation.selection.source : mutation.source);
      const required = this.request.requiredSources.find((selection) => sourceId(selection.source) === id);
      if (required && (mutation.kind === 'remove' || canonicalJSON(required) !== canonicalJSON(mutation.selection))) {
        throw new WorkspaceFailure('requiredMaterialMutation', { id });
      }
      if (mutation.kind === 'upsert') {
        const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
        try {
          prepared = await acquireSource(operation, mutation.selection, required !== undefined);
        } finally {
          await operation.close();
        }
      }
    } else {
      strictText(mutation.handoff.clarifiedTask);
      strictText(mutation.handoff.architecture);
      mutation.handoff.relationships.forEach(strictText);
      mutation.handoff.ambiguities.forEach(strictText);
    }
    this.#check(signal, input.expectedRevision);
    if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
    const current = [...this.#materials.values()], next = current.filter((material) => material.record.id !== id);
    if (prepared) next.push(prepared);
    const handoff = mutation.kind === 'handoff' ? freeze(mutation.handoff) : this.#handoff;
    const changed =
      canonicalJSON(current.find((material) => material.record.id === id) ?? null) !== canonicalJSON(prepared) ||
      canonicalJSON(handoff) !== canonicalJSON(this.#handoff);
    const revision = this.#revision + (changed ? 1 : 0);
    const rendered = renderBundle({
      request: this.request,
      inventory: this.operation.snapshot,
      handoff,
      materials: next,
    });
    const changedCosts = rendered.costs.filter((cost) => cost.id === id);
    if (id && !prepared) changedCosts.push({ id, bytes: 0, units: 0 });
    const receipt = (costs: typeof changedCosts, incompleteDetails: boolean) => ({
      kind: 'mutation' as const,
      revision,
      changedCosts: costs,
      incompleteDetails,
      measurement: rendered.measurement,
      diagnostics: rendered.diagnostics,
      costInspection: { draftId: this.id, revision },
    });
    const minimum = receipt([], changedCosts.length > 0);
    const minimumBytes = serializedBytes(encode(minimum));
    if (minimumBytes > input.maxOutputBytes) {
      throw new WorkspaceFailure('outputBudgetTooSmall', { requiredBytes: minimumBytes });
    }
    const complete = receipt(changedCosts, false);
    const result = serializedBytes(encode(complete)) <= input.maxOutputBytes ? complete : minimum;
    if (id) {
      if (prepared) this.#materials.set(id, prepared);
      else this.#materials.delete(id);
    }
    this.#handoff = handoff;
    this.#revision = revision;
    return freeze(result);
  }
  inspect(input: DraftInspection, encode: ResultEncoding = identityEncoding) {
    if (!inspectionValidator.Check(input)) throw new WorkspaceFailure('invalidRequest');
    const request = structuredClone(input);
    const { maxOutputBytes, continuation } = request;
    if (request.view === 'material') {
      const material = this.#materials.get(request.materialId);
      if (!material) throw new WorkspaceFailure('materialUnavailable', { id: request.materialId });
      const text = material.bodies.join('');
      const digest = sha256(canonicalJSON({ id: this.id, material: material.record, text }));
      return pageResult(
        prepareText(Buffer.from(text)).lines,
        pageOffset(continuation, digest),
        maxOutputBytes,
        (lines, next) => ({
          kind: 'material' as const,
          materialId: request.materialId,
          digest,
          lines,
          truncated: next !== null,
          continuation: next === null ? null : { digest, offset: next },
        }),
        encode,
      );
    }
    const materials = [...this.#materials.values()],
      rendered = renderBundle({
        request: this.request,
        inventory: this.operation.snapshot,
        handoff: this.#handoff,
        materials,
      });
    const digest = sha256(canonicalJSON({ id: this.id, revision: this.#revision, view: request.view }));
    const handoff: HandoffInspection = this.#handoff === null
      ? { kind: 'handoff', state: 'unset' }
      : { kind: 'handoff', state: 'set', handoff: this.#handoff };
    const records: (ItemCost | ReturnType<typeof materialMetadata> | HandoffInspection)[] = request.view === 'costs'
      ? rendered.costs
      : [...materials.map((material) => materialMetadata(material.record)), handoff];
    return pageResult(
      records,
      pageOffset(continuation, digest),
      maxOutputBytes,
      (items, next) => ({
        kind: request.view,
        draftId: this.id,
        revision: this.#revision,
        state: this.#state,
        items,
        measurement: rendered.measurement,
        diagnostics: rendered.diagnostics,
        truncated: next !== null,
        continuation: next === null ? null : { digest, offset: next },
      }),
      encode,
    );
  }
  selectionProjection() {
    return freeze({
      draftId: this.id,
      revision: this.#revision,
      sources: [...this.#materials.values()].flatMap((material) =>
        material.record.kind === 'source' ? [material.record.selection.source] : []
      ),
    });
  }
  validate(signal: AbortSignal) {
    return this.#track((async () => {
      this.#check(signal, this.#revision);
      const revision = this.#revision, materials = [...this.#materials.values()], handoff = this.#handoff;
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        await revalidateMaterials(operation, materials);
        const rendered = renderBundle({
          request: this.request,
          inventory: this.operation.snapshot,
          handoff,
          materials,
        });
        return freeze({
          kind: 'validation' as const,
          revision,
          measurement: rendered.measurement,
          costs: rendered.costs,
          diagnostics: rendered.diagnostics,
        });
      } finally {
        await operation.close();
      }
    })());
  }
  /** Resolves after a terminal outcome has released this draft's lease; a correctable blocked result reopens editing. */
  async finalize(signal: AbortSignal, publishing: () => void = () => {}): Promise<FinalizationResult> {
    if (this.#finalized) return this.#finalized;
    this.#check(signal, this.#revision);
    this.#state = 'frozen';
    this.#freezeGeneration++;
    const operation = new FinalizationOperation(
      this.operation,
      this.request,
      this.#handoff,
      [...this.#materials.values()],
      this.#revision,
      signal,
      publishing,
    );
    this.#finalization = operation;
    const terminal = async () => {
      this.#state = 'terminal';
      await this.close();
    };
    this.#finalized = operation.result.then(async (result) => {
      if (result.kind === 'blocked') {
        if (!this.#closing) {
          this.#state = 'editable';
          this.#finalization = null;
          this.#finalized = null;
        }
        return result;
      }
      await terminal();
      return result;
    }, async (error: unknown) => {
      await terminal();
      throw error;
    });
    return this.#finalized;
  }
  cancelFinalization() {
    return this.#finalization?.cancel() ?? { kind: 'notFinalizing' as const };
  }
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#cancel.abort();
      this.#finalization?.cancel();
      await Promise.allSettled([...this.#pending, ...(this.#finalization ? [this.#finalization.result] : [])]);
      await this.operation.close();
      this.onClosed();
      this.#state = 'terminal';
    })();
    return this.#closing;
  }
}
