import { randomUUID } from 'node:crypto';
import {
  type ContextBuildRequest,
  type CodemapMode,
  contextRequestValidator,
  type DraftInspection,
  type DraftUpdate,
  type Handoff,
  inspectionValidator,
  updateValidator,
} from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { SourcePath } from '../contracts/inventory.js';
import { canonicalJSON, compareBytes, freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
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
import { type ItemCost, materialMetadata, renderBundle, renderInitialContext } from './render.js';
import { revalidateMaterials } from './revalidate.js';
import { resolveAllowance } from './budget.js';
import { FinalizationOperation, type FinalizationResult } from './finalize.js';
import { StructureIndex } from '../workspace/structure-index.js';
import { failureCode } from '../runtime/tool-result.js';

const inferredSourceFailures = new Set(['sourceChanged', 'policyChanged', 'pathDenied', 'decodeFailed', 'binarySource',
  'notFound', 'permissionDenied', 'nonRegularFile', 'symlink', 'nativeIOFailed']);

type HandoffInspection =
  | { readonly kind: 'handoff'; readonly state: 'unset' }
  | { readonly kind: 'handoff'; readonly state: 'set'; readonly handoff: Handoff };

export class DraftRuntime {
  readonly id = randomUUID();
  #materials: ReadonlyMap<string, Material> = new Map();
  #codemapMode: CodemapMode;
  #structure: StructureIndex | null = null;
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
  ) {
    this.#codemapMode = request.requiredSources.some(selection => selection.kind === 'codemap') ? 'manual' : 'automatic';
  }
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
    const allowance = resolveAllowance(request.allowance);
    if (allowance !== null && allowance > operation.runtime.options.contextBudgetUnits) {
      throw new WorkspaceFailure('assemblyBudgetExceeded', { allowance, maximum: operation.runtime.options.contextBudgetUnits });
    }
    if (
      new Set(request.requiredSources.map((selection) => sourceId(selection.source))).size !==
        request.requiredSources.length ||
      new Set(request.documents.map((document) => document.id)).size !== request.documents.length ||
      new Set(request.patches.map((patch) => patch.id)).size !== request.patches.length
    ) throw new WorkspaceFailure('duplicateMaterial');
    const draft = new DraftRuntime(operation, request, onClosed), admission = await operation.fork(signal);
    const materials = new Map<string, Material>();
    try {
      for (const selection of request.requiredSources) {
        const material = await acquireSource(admission, { selectionOrigin: 'explicit', selection, required: true });
        materials.set(material.record.id, material);
      }
      for (const document of request.documents) {
        const material = await acquireDocument(admission, document);
        materials.set(material.record.id, material);
      }
      for (const patch of request.patches) {
        const material = await acquirePatch(admission, patch);
        materials.set(material.record.id, material);
      }
      draft.#materials = await draft.#derive(admission, materials, draft.#codemapMode, draft.#materials, 0);
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
  async #derive(operation: WorkspaceOperation, explicit: Map<string, Material>, mode: CodemapMode,
    previous: ReadonlyMap<string, Material>, revision: number): Promise<ReadonlyMap<string, Material>> {
    if (mode === 'manual') return explicit;
    const seeds = [...explicit.values()].flatMap(({ record }) =>
      record.kind === 'source' && record.selection.kind !== 'codemap' ? [record.selection.source] : []);
    if (!seeds.length) return explicit;
    const targets = (this.#structure ??= new StructureIndex(this.operation.snapshot)).resolveAutomaticCodemapTargets(seeds);
    for (const target of targets) {
      const source = { root: target.root, path: target.path }, id = sourceId(source), existing = previous.get(id);
      if (existing?.record.kind === 'source' && existing.record.selectionOrigin === 'inferred') {
        explicit.set(id, existing);
        continue;
      }
      explicit.set(id, await this.#acquireInferred(operation, source, revision));
    }
    return explicit;
  }
  async #acquireInferred(operation: WorkspaceOperation, source: SourcePath, revision: number): Promise<Material> {
    try {
      return await acquireSource(operation, { selectionOrigin: 'inferred', source });
    } catch (error) {
      const cause = failureCode(error);
      const sourceFailure = inferredSourceFailures.has(cause);
      if (cause !== 'cancelled') process.stderr.write(JSON.stringify({ level: sourceFailure ? 'warn' : 'error',
        event: 'automaticCodemapAcquisitionFailed', draftId: this.id, revision,
        inventoryDigest: this.operation.snapshot.inventoryDigest, ...source, cause }) + '\n');
      if (sourceFailure) throw new WorkspaceFailure('automaticCodemapUnavailable', { source, cause });
      throw error;
    }
  }
  async #update(input: DraftUpdate, signal: AbortSignal, encode: ResultEncoding) {
    this.#check(signal, input.expectedRevision);
    const freezeGeneration = this.#freezeGeneration, current = this.#materials;
    const mutation = input.mutation;
    let next: ReadonlyMap<string, Material> = current, mode = this.#codemapMode, handoff = this.#handoff;
    if (mutation.kind === 'addDocument') {
      const id = 'document:' + mutation.document.id;
      if (current.has(id)) throw new WorkspaceFailure('duplicateMaterial', { id });
      const prepared = await acquireDocument(this.operation, mutation.document);
      next = new Map(current).set(id, prepared);
    } else if (mutation.kind === 'handoff') {
      strictText(mutation.handoff.clarifiedTask);
      strictText(mutation.handoff.architecture);
      mutation.handoff.relationships.forEach(strictText);
      mutation.handoff.ambiguities.forEach(strictText);
      handoff = freeze(mutation.handoff);
    } else {
      const explicit = new Map([...current].filter(([, material]) =>
        material.record.kind !== 'source' || material.record.selectionOrigin === 'explicit'));
      let required = false;
      if (mutation.kind === 'upsert' || mutation.kind === 'remove') {
        const id = sourceId(mutation.kind === 'upsert' ? mutation.selection.source : mutation.source);
        const selection = this.request.requiredSources.find(selection => sourceId(selection.source) === id);
        required = selection !== undefined;
        if (selection && (mutation.kind === 'remove' || canonicalJSON(selection) !== canonicalJSON(mutation.selection))) {
          throw new WorkspaceFailure('requiredMaterialMutation', { id });
        }
        if (mutation.kind === 'remove') explicit.delete(id);
        else if (!required && mutation.selection.kind === 'codemap') mode = 'manual';
      } else {
        for (const [id, { record }] of explicit) {
          if (record.kind === 'source' && !record.required &&
              (mutation.kind === 'clearSources' || record.selection.kind === 'codemap')) explicit.delete(id);
        }
        mode = mutation.kind === 'clearCodemaps' || this.request.requiredSources.some(selection => selection.kind === 'codemap')
          ? 'manual' : 'automatic';
      }
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        if (mutation.kind === 'upsert') {
          const prepared = await acquireSource(operation, { selectionOrigin: 'explicit', selection: mutation.selection, required });
          explicit.set(prepared.record.id, prepared);
        }
        next = await this.#derive(operation, explicit, mode, current, input.expectedRevision);
      } finally { await operation.close(); }
    }
    this.#check(signal, input.expectedRevision);
    if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
    const changedIds = [...new Set([...current.keys(), ...next.keys()])].filter(id =>
      current.get(id) !== next.get(id) && canonicalJSON(current.get(id) ?? null) !== canonicalJSON(next.get(id) ?? null)).sort(compareBytes);
    const changed = changedIds.length > 0 || mode !== this.#codemapMode || canonicalJSON(handoff) !== canonicalJSON(this.#handoff);
    const revision = this.#revision + (changed ? 1 : 0);
    const rendered = renderBundle({ request: this.request, inventory: this.operation.snapshot, handoff,
      codemapMode: mode, materials: [...next.values()] });
    const changedSet = new Set(changedIds);
    const changedCosts = rendered.costs.filter(cost => changedSet.has(cost.id));
    for (const id of changedIds) if (!next.has(id)) changedCosts.push({ id, bytes: 0, units: 0 });
    changedCosts.sort((a, b) => compareBytes(a.id, b.id));
    const receipt = (costs: typeof changedCosts, incompleteDetails: boolean) => ({
      kind: 'mutation' as const, revision, codemapMode: mode, changedCosts: costs, incompleteDetails,
      measurement: rendered.measurement, diagnostics: rendered.diagnostics,
      costInspection: { draftId: this.id, revision },
    });
    const minimum = receipt([], changedCosts.length > 0);
    const minimumBytes = serializedBytes(encode(minimum));
    if (minimumBytes > input.maxOutputBytes) throw new WorkspaceFailure('outputBudgetTooSmall', { requiredBytes: minimumBytes });
    const complete = receipt(changedCosts, false);
    const result = serializedBytes(encode(complete)) <= input.maxOutputBytes ? complete : minimum;
    if (changed) {
      this.#materials = next; this.#codemapMode = mode; this.#handoff = handoff; this.#revision = revision;
    }
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
        codemapMode: this.#codemapMode,
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
        codemapMode: this.#codemapMode,
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
  /** Read-only observation at invocation; JobRegistry captures it after admission and before dispatch. */
  initialContext(): string {
    return renderInitialContext({ request: this.request, inventory: this.operation.snapshot, materials: [...this.#materials.values()],
      handoff: this.#handoff, codemapMode: this.#codemapMode, draftId: this.id, revision: this.#revision,
      contextBudgetUnits: this.operation.runtime.options.contextBudgetUnits });
  }
  validate(signal: AbortSignal) {
    return this.#track((async () => {
      this.#check(signal, this.#revision);
      const revision = this.#revision, materials = [...this.#materials.values()], handoff = this.#handoff, codemapMode = this.#codemapMode;
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        await revalidateMaterials(operation, materials);
        const rendered = renderBundle({
          codemapMode,
          request: this.request,
          inventory: this.operation.snapshot,
          handoff,
          materials,
        });
        return freeze({
          kind: 'validation' as const,
          codemapMode,
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
      this.#codemapMode,
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
      this.#structure = null;
      await this.operation.close();
      this.onClosed();
      this.#state = 'terminal';
    })();
    return this.#closing;
  }
}
