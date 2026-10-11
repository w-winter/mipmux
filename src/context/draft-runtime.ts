import { randomUUID } from 'node:crypto';
import {
  type ContextBuildRequest,
  type CodemapMode,
  contextRequestValidator,
  type DraftInspection,
  type DraftUpdate,
  type PromptRequest,
  inspectionValidator,
  updateValidator,
  PromptRequest as PromptRequestSchema,
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
import { Compile } from 'typebox/compile';

const inferredSourceFailures = new Set(['sourceChanged', 'policyChanged', 'pathDenied', 'decodeFailed', 'binarySource',
  'notFound', 'permissionDenied', 'nonRegularFile', 'symlink', 'nativeIOFailed']);

const promptValidator = Compile(PromptRequestSchema);
type SourceMutation = Exclude<DraftUpdate['mutation'], { kind: 'prompt' | 'addDocument' }>;

export class DraftRuntime {
  readonly id = randomUUID();
  #materials: ReadonlyMap<string, Material> = new Map();
  #codemapMode: CodemapMode;
  #structure: StructureIndex | null = null;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #cancel = new AbortController();
  #revision = 0;
  #freezeGeneration = 0;
  #prompt: string;
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
    this.#prompt = request.task;
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
  /** Literal prompt operations share revision and receipt admission with material mutations. */
  async prompt(input: PromptRequest, signal: AbortSignal, encode: ResultEncoding = identityEncoding) {
    if (!promptValidator.Check(input)) throw new WorkspaceFailure('invalidRequest');
    const request = structuredClone(input);
    this.#check(signal, request.op === 'get' ? this.#revision : request.expectedRevision);
    if (request.op === 'get') {
      const result = { kind: 'prompt' as const, op: request.op, revision: this.#revision, prompt: this.#prompt };
      const requiredBytes = serializedBytes(encode(result));
      if (requiredBytes > request.maxOutputBytes) throw new WorkspaceFailure('outputBudgetTooSmall', { requiredBytes });
      return freeze(result);
    }
    const { expectedRevision, maxOutputBytes, ...mutation } = request;
    const update = { expectedRevision, maxOutputBytes, mutation: { kind: 'prompt' as const, ...mutation } };
    const prompt = request.op === 'clear' ? '' : request.op === 'append' ? this.#prompt + request.text : request.text;
    const result = await this.#track(this.#update(update, signal, encode, { op: request.op, prompt }));
    return freeze({ kind: 'prompt' as const, op: request.op, revision: result.revision, prompt });
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
  async #update(input: DraftUpdate, signal: AbortSignal, encode: ResultEncoding,
    promptResponse: { readonly op: 'set' | 'append' | 'clear'; readonly prompt: string } | null = null) {
    this.#check(signal, input.expectedRevision);
    const freezeGeneration = this.#freezeGeneration, current = this.#materials;
    const mutation = input.mutation;
    let next: ReadonlyMap<string, Material> = current, mode = this.#codemapMode, prompt = this.#prompt;
    if (mutation.kind === 'addDocument') {
      const id = 'document:' + mutation.document.id;
      if (current.has(id)) throw new WorkspaceFailure('duplicateMaterial', { id });
      const prepared = await acquireDocument(this.operation, mutation.document);
      next = new Map(current).set(id, prepared);
    } else if (mutation.kind === 'prompt') {
      if (mutation.op !== 'clear') strictText(mutation.text);
      prompt = mutation.op === 'clear' ? '' : mutation.op === 'append' ? prompt + mutation.text : mutation.text;
    } else {
      ({ next, mode } = await this.#prepareSources(mutation, current, input.expectedRevision, signal));
    }
    this.#check(signal, input.expectedRevision);
    if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
    const { changed, revision, result } = this.#mutationReceipt(current, next, mode, prompt, input.maxOutputBytes, encode, promptResponse);
    if (changed) {
      this.#materials = next; this.#codemapMode = mode; this.#prompt = prompt; this.#revision = revision;
    }
    return freeze(result);
  }
  #mutationReceipt(current: ReadonlyMap<string, Material>, next: ReadonlyMap<string, Material>, mode: CodemapMode,
    prompt: string, maxOutputBytes: number, encode: ResultEncoding,
    promptResponse: { readonly op: 'set' | 'append' | 'clear'; readonly prompt: string } | null) {
    const changedIds = [...new Set([...current.keys(), ...next.keys()])].filter(id =>
      current.get(id) !== next.get(id) && canonicalJSON(current.get(id) ?? null) !== canonicalJSON(next.get(id) ?? null)).sort(compareBytes);
    const changed = changedIds.length > 0 || mode !== this.#codemapMode || prompt !== this.#prompt;
    const revision = this.#revision + (changed ? 1 : 0);
    const rendered = renderBundle({ request: this.request, inventory: this.operation.snapshot, prompt,
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
    const promptReceipt = promptResponse === null ? null : { kind: 'prompt' as const, revision, ...promptResponse };
    const minimumBytes = serializedBytes(encode(promptReceipt ?? minimum));
    if (minimumBytes > maxOutputBytes) throw new WorkspaceFailure('outputBudgetTooSmall', { requiredBytes: minimumBytes });
    const complete = receipt(changedCosts, false);
    const result = serializedBytes(encode(complete)) <= maxOutputBytes ? complete : minimum;
    return { changed, revision, result };
  }
  async #prepareSources(mutation: SourceMutation, current: ReadonlyMap<string, Material>, revision: number, signal: AbortSignal) {
    const explicit = new Map([...current].filter(([, material]) =>
      material.record.kind !== 'source' || material.record.selectionOrigin === 'explicit'));
    let required = false, mode: CodemapMode;
    if (mutation.kind === 'upsert' || mutation.kind === 'remove') {
      ({ required, mode } = this.#changeSourceIntent(mutation, explicit));
    } else mode = this.#clearSourceIntent(mutation.kind, explicit);
    const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
    try {
      if (mutation.kind === 'upsert') {
        const prepared = await acquireSource(operation, { selectionOrigin: 'explicit', selection: mutation.selection, required });
        explicit.set(prepared.record.id, prepared);
      }
      const next = await this.#derive(operation, explicit, mode, current, revision);
      return { next, mode };
    } finally { await operation.close(); }
  }
  #changeSourceIntent(mutation: Extract<SourceMutation, { kind: 'upsert' | 'remove' }>, explicit: Map<string, Material>) {
    const id = sourceId(mutation.kind === 'upsert' ? mutation.selection.source : mutation.source);
    const selection = this.request.requiredSources.find(selection => sourceId(selection.source) === id);
    const required = selection !== undefined;
    if (selection && (mutation.kind === 'remove' || canonicalJSON(selection) !== canonicalJSON(mutation.selection))) {
      throw new WorkspaceFailure('requiredMaterialMutation', { id });
    }
    let mode = this.#codemapMode;
    if (mutation.kind === 'remove') explicit.delete(id);
    else if (!required && mutation.selection.kind === 'codemap') mode = 'manual';
    return { required, mode };
  }
  #clearSourceIntent(kind: 'clearSources' | 'clearCodemaps', explicit: Map<string, Material>): CodemapMode {
    for (const [id, { record }] of explicit) {
      if (record.kind === 'source' && !record.required &&
          (kind === 'clearSources' || record.selection.kind === 'codemap')) explicit.delete(id);
    }
    return kind === 'clearCodemaps' || this.request.requiredSources.some(selection => selection.kind === 'codemap')
      ? 'manual' : 'automatic';
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
        prompt: this.#prompt,
        materials,
      });
    const digest = sha256(canonicalJSON({ id: this.id, revision: this.#revision, view: request.view }));
    const prompt = { kind: 'prompt' as const, prompt: this.#prompt };
    const records: (ItemCost | ReturnType<typeof materialMetadata> | typeof prompt)[] = request.view === 'costs'
      ? rendered.costs
      : [...materials.map((material) => materialMetadata(material.record)), prompt];
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
      prompt: this.#prompt, codemapMode: this.#codemapMode, draftId: this.id, revision: this.#revision,
      contextBudgetUnits: this.operation.runtime.options.contextBudgetUnits });
  }
  validate(signal: AbortSignal) {
    return this.#track((async () => {
      this.#check(signal, this.#revision);
      const revision = this.#revision, materials = [...this.#materials.values()], prompt = this.#prompt, codemapMode = this.#codemapMode;
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        await revalidateMaterials(operation, materials);
        const rendered = renderBundle({
          codemapMode,
          request: this.request,
          inventory: this.operation.snapshot,
          prompt,
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
      this.#prompt,
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
