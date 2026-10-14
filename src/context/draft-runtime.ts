import { randomUUID } from 'node:crypto';
import {
  type ContextBuildRequest,
  type CodemapMode,
  contextRequestValidator,
  type DraftInspection,
  type DraftUpdate,
  type SourceEdit,
  DraftPreview,
  type PromptRequest,
  inspectionValidator,
  updateValidator,
  PromptRequest as PromptRequestSchema,
} from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { SourcePath } from '../contracts/inventory.js';
import type { NativeSelectionReplyInput } from '../contracts/native.js';
import type { Static } from 'typebox';
import { canonicalJSON, compareBytes, freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
import { pageResult, serializedBytes, identityEncoding, type ResultEncoding } from '../exploration/output-budget.js';
import { pageOffset } from '../exploration/continuation.js';
import { prepareText } from '../exploration/lines.js';
import {
  acquireDocument,
  acquireSource,
  prepareCodemapSelection,
  type Material,
  sourceId,
  strictText,
} from './material-store.js';
import { acquirePatch } from '../patches/patch-input.js';
import { type ItemCost, materialMetadata, renderBundle, renderInitialContext } from './render.js';
import { revalidateMaterials } from './revalidate.js';
import { FinalizationOperation, type FinalizationResult } from './finalize.js';
import { StructureIndex } from '../workspace/structure-index.js';
import { failureCode } from '../runtime/tool-result.js';
import { Compile } from 'typebox/compile';
import { initialFileTree } from '../exploration/tree.js';
import { selectionValidator, type SelectionRequest } from '../contracts/selection.js';
import { prepareSelection } from './selection-preparation.js';
import { estimateUnits } from './budget.js';
import { posix } from 'node:path';
import { resolveSelectedCodemaps } from './codemap-readiness.js';
import { descriptorGitMode } from '../contracts/patches.js';
import { prepareRenderInput } from './final-tree.js';
import { FrozenGitTarget, selectedGitSourcePaths } from './git-target.js';
import type { GitRequest } from '../contracts/git.js';
import { readElectedDiff, captureElectedGitDiff } from '../exploration/git-diff.js';
import { publishGitSnapshot, prepareGitPublicationMetadata } from './git-publication.js';
import { resolveDiffRepository } from '../exploration/git-repository.js';
import { publishGitSnapshotBatch } from './git-publication-batch.js';
import { GitSnapshotPublicationOptions } from '../contracts/git-snapshot.js';

const inferredSourceFailures = new Set(['sourceChanged', 'policyChanged', 'pathDenied', 'decodeFailed', 'binarySource',
  'notFound', 'permissionDenied', 'nonRegularFile', 'symlink', 'nativeIOFailed']);

const promptValidator = Compile(PromptRequestSchema), previewValidator = Compile(DraftPreview);
const snapshotPublicationValidator = Compile(GitSnapshotPublicationOptions);
type SourceMutation = Exclude<SourceEdit, { kind: 'slices' }>;
type SelectionReplyEntry = Static<typeof NativeSelectionReplyInput>['entries'][number];
type SelectionReplyFile = Omit<Extract<SelectionReplyEntry, { kind: 'full' }>, 'kind'>;

export class DraftRuntime {
  readonly id = randomUUID();
  #materials: ReadonlyMap<string, Material> = new Map();
  #codemapMode: CodemapMode;
  #structure: { readonly digest: string; readonly index: StructureIndex } | null = null;
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
    private readonly gitTarget: FrozenGitTarget,
  ) {
    this.#codemapMode = request.requiredSources.some(selection => selection.kind === 'codemap') ? 'manual' : request.initialSelection.codemapMode;
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
    if (operation.snapshot.enumeration.kind !== 'complete') throw new WorkspaceFailure('enumerationIncomplete');
    if (!contextRequestValidator.Check(input)) throw new WorkspaceFailure('invalidRequest');
    const request = freeze(structuredClone(input));
    strictText(request.task);
    strictText(request.constraints);
    request.discoveryHints.forEach(strictText);
    const allowance = request.budgetUnits;
    if (allowance > operation.runtime.options.contextBudgetUnits) {
      throw new WorkspaceFailure('assemblyBudgetExceeded', { allowance, maximum: operation.runtime.options.contextBudgetUnits });
    }
    if (
      new Set(request.requiredSources.map((selection) => sourceId(selection.source))).size !==
        request.requiredSources.length ||
      new Set(request.initialSelection.sources.map((selection) => sourceId(selection.source))).size !== request.initialSelection.sources.length ||
      new Set(request.documents.map((document) => document.id)).size !== request.documents.length ||
      new Set(request.patches.map((patch) => patch.id)).size !== request.patches.length
    ) throw new WorkspaceFailure('duplicateMaterial');
    const admission = await operation.fork(signal);
    const materials = new Map<string, Material>();
    try {
      for (const selection of request.requiredSources) {
        const material = await acquireSource(admission, { selectionOrigin: 'explicit', selection, required: true });
        materials.set(material.record.id, material);
      }
      for (const selection of request.initialSelection.sources) {
        const existing = materials.get(sourceId(selection.source));
        if (existing) {
          if (existing.record.kind !== 'source' || canonicalJSON(existing.record.selection) !== canonicalJSON(selection)) {
            throw new WorkspaceFailure('requiredMaterialMutation', { id: existing.record.id });
          }
        } else {
          const material = await acquireSource(admission, { selectionOrigin: 'explicit', selection, required: false });
          materials.set(material.record.id, material);
        }
      }
      for (const document of request.documents) {
        const material = await acquireDocument(admission, document);
        materials.set(material.record.id, material);
      }
      for (const patch of request.patches) {
        const material = await acquirePatch(admission, patch);
        materials.set(material.record.id, material);
      }
      const target = await FrozenGitTarget.capture(admission, materials);
      const draft = new DraftRuntime(operation, request, onClosed, target);
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
  readImplicitGitDiff(input: Extract<GitRequest, { op: 'diff' }>, signal: AbortSignal, encode: ResultEncoding) {
    return this.#track((async () => {
      this.#check(signal, this.#revision);
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        const checkout = await this.gitTarget.primary(operation);
        return await readElectedDiff(operation, structuredClone(input), checkout, encode);
      } finally { await operation.close(); }
    })());
  }
  /** Captures publication evidence only after frozen/current ownership admission and an unchanged draft revision. */
  captureGitPublication(input: Extract<GitRequest, { op: 'diff' }>, generateDiffText: boolean,
    scope: Static<typeof GitSnapshotPublicationOptions>['scope'], signal: AbortSignal) {
    const request = structuredClone(input), revision = this.#revision, current = this.#materials;
    return this.#track((async () => {
      this.#check(signal, revision);
      const generation = this.#freezeGeneration;
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        const checkout = await this.gitTarget.publication(operation, current, request);
        this.#check(signal, revision);
        if (generation !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
        const paths = scope === 'selected' ? selectedGitSourcePaths(operation, current) : null;
        const captured = await captureElectedGitDiff(operation, request, checkout, generateDiffText, paths);
        this.#check(signal, revision);
        if (generation !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
        return { ...captured, checkout };
      } finally { await operation.close(); }
    })());
  }
  /** Writes a snapshot without mutating selection or installing artifact insertion authority. */
  publishGitSnapshot(input: Extract<GitRequest, { op: 'diff' }>, options: Static<typeof GitSnapshotPublicationOptions>, signal: AbortSignal) {
    const request = structuredClone(input), parsed = snapshotPublicationValidator.Parse(structuredClone(options));
    const id = parsed.snapshotID?.trim();
    const capturedOptions = { ...parsed, snapshotID: id && id.toLowerCase() !== 'auto' ? id : null,
      inlineMode: parsed.inlineMode.toLowerCase(), inlineMaxLines: Math.max(1, parsed.inlineMaxLines) };
    const revision = this.#revision, generation = this.#freezeGeneration;
    return this.#track((async () => {
      this.#check(signal, revision);
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      const check = () => {
        this.#check(signal, revision);
        if (generation !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
      };
      try {
        const checkouts = await this.gitTarget.publicationRepositories(operation, this.#materials, request);
        check();
        const publishSingle = async () => {
          const checkout = checkouts[0];
          if (!checkout) throw new WorkspaceFailure('gitPublicationTargetDenied');
          const repository = await resolveDiffRepository(operation, checkout.root, { kind: 'elected', checkout });
          const prepared = await prepareGitPublicationMetadata(operation, checkout, repository);
          const captured = await this.captureGitPublication(request, capturedOptions.mode !== 'quick', capturedOptions.scope, signal);
          return publishGitSnapshot(operation, captured, request, capturedOptions, this.id, check, prepared);
        };
        const published = checkouts.length > 1
          ? await publishGitSnapshotBatch(operation, checkouts, selectedGitSourcePaths(operation, this.#materials),
            request, capturedOptions, this.id, check)
          : await publishSingle();
        check();
        await this.gitTarget.publicationRepositories(operation, this.#materials, request);
        return published;
      } finally { await operation.close(); }
    })());
  }
  update(input: DraftUpdate, signal: AbortSignal, encode: ResultEncoding = identityEncoding) {
    if (!updateValidator.Check(input)) return Promise.reject(new WorkspaceFailure('invalidRequest'));
    return this.#track(this.#update(structuredClone(input), signal, encode));
  }
  manageSelection(input: SelectionRequest, signal: AbortSignal, encode: ResultEncoding = identityEncoding) {
    if (!selectionValidator.Check(input)) return Promise.reject(new WorkspaceFailure('invalidRequest'));
    const request = structuredClone(input);
    return this.#track((async () => {
      const revision = request.expectedRevision ?? this.#revision;
      this.#check(signal, revision);
      const freezeGeneration = this.#freezeGeneration, current = this.#materials, prompt = this.#prompt;
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        const prepared = await prepareSelection(operation, request, current, this.#codemapMode);
        const next = request.op === 'get' ? current
          : await this.#prepareResolvedSelection(operation, prepared, current, revision);
        const candidate = this.#mutationChanges(current, next, prepared.mode, this.#prompt);
        const isMutation = request.op !== 'get' && request.op !== 'preview';
        this.#check(signal, revision);
        if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
        if (isMutation && candidate.changed) {
          this.#commit(next, prepared.mode, this.#prompt, candidate.revision);
        }
        const settled = await resolveSelectedCodemaps(operation, next);
        if (request.op !== 'preview') this.#retainReadyCodemaps(next, settled);
        const reply = await this.#selectionReply(operation, request, settled, prepared.mode, prepared.invalid,
          isMutation ? candidate.revision : revision, prompt);
        operation.signal.throwIfAborted();
        if (request.op === 'preview' && request.strict && !reply.files.length && !reply.file_slices?.length) {
          throw new WorkspaceFailure('invalidSelection', { message: await operation.selectionHint(prepared.hintPaths, 'preview') });
        }
        const requiredBytes = serializedBytes(encode(reply));
        if (requiredBytes > request.maxOutputBytes) throw new WorkspaceFailure('outputBudgetTooSmall', { requiredBytes });
        return freeze(reply);
      } finally { await operation.close(); }
    })());
  }
  async #prepareResolvedSelection(operation: WorkspaceOperation, prepared: Awaited<ReturnType<typeof prepareSelection>>,
    current: ReadonlyMap<string, Material>, revision: number): Promise<ReadonlyMap<string, Material>> {
    const explicit = new Map([...current].filter(([, material]) => material.record.kind !== 'source'));
    for (const required of this.request.requiredSources) {
      if (!prepared.selections.some(selection => canonicalJSON(selection) === canonicalJSON(required))) {
        throw new WorkspaceFailure('requiredMaterialMutation', { id: sourceId(required.source) });
      }
    }
    for (const selection of prepared.selections) {
      const id = sourceId(selection.source), existing = current.get(id);
      const required = this.request.requiredSources.some(required => sourceId(required.source) === id);
      const material = existing?.record.kind === 'source' && existing.record.selectionOrigin === 'explicit'
        && canonicalJSON(existing.record.selection) === canonicalJSON(selection) ? existing
        : selection.kind === 'codemap' && !required ? await prepareCodemapSelection(operation, selection)
        : await acquireSource(operation, { selectionOrigin: 'explicit', selection, required });
      explicit.set(id, material);
    }
    return this.#derive(operation, explicit, prepared.mode, current, revision);
  }
  #retainReadyCodemaps(pending: ReadonlyMap<string, Material>, settled: ReadonlyMap<string, Material>): void {
    if (this.#closing || this.#state !== 'editable') return;
    const next = new Map(this.#materials);
    for (const [id, material] of settled) {
      const previous = pending.get(id);
      if (previous?.availability === 'pendingCodemap' && material.availability === 'settled' && next.get(id) === previous) {
        next.set(id, material);
      }
    }
    this.#materials = next;
  }
  async #selectionReply(operation: WorkspaceOperation, request: SelectionRequest, materials: ReadonlyMap<string, Material>, mode: CodemapMode,
    invalid: readonly string[], revision: number, prompt: string) {
    const snapshot = operation.snapshot;
    const rendered = renderBundle(await prepareRenderInput(this.operation.runtime, { request: this.request, inventory: snapshot,
      prompt, codemapMode: mode, materials: [...materials.values()] }, operation.signal));
    const unmapped: string[] = [];
    const pending: string[] = [];
    const entries: Static<typeof NativeSelectionReplyInput>['entries'] = [];
    const blocks: string[] = [];
    for (const material of materials.values()) {
      const record = material.record;
      if (record.kind !== 'source') continue;
      const root = snapshot.roots.find(root => root.name === record.selection.source.root)!;
      const relative = snapshot.roots.length === 1 ? record.selection.source.path
        : root.name + '/' + record.selection.source.path;
      const path = request.path_display === 'full' ? posix.join(root.identity.canonicalPath, record.selection.source.path) : relative;
      if (material.availability === 'pendingCodemap') { pending.push(path); continue; }
      if (record.selection.kind === 'codemap' && !material.bodies.length) { unmapped.push(path); continue; }
      const fields = { path, tokens: estimateUnits(Buffer.byteLength(material.bodies.join(''))),
        rootPath: root.name, pathWithinRoot: record.selection.source.path };
      entries.push(this.#selectionFileEntry(record, fields));
      if (request.view === 'content') blocks.push(await this.#sourceBlock(operation, record, material.bodies, path));
    }
    const reply = await operation.renderSelectionReply({ kind: 'renderSelectionReply', entries,
      status: request.op === 'preview' ? 'preview' : 'ok', codemapAutoEnabled: mode === 'automatic',
      invalidPaths: [...invalid], unmappedPaths: unmapped, pendingPaths: pending,
      blocks: request.view === 'content' ? blocks : null, view: request.view });
    return { ...reply, revision, measurement: rendered.measurement, diagnostics: rendered.diagnostics };
  }
  async #sourceBlock(operation: WorkspaceOperation, record: Extract<Material['record'], { kind: 'source' }>,
    bodies: readonly string[], path: string): Promise<string> {
    if (record.selection.kind === 'codemap') return bodies.join('');
    let content = bodies.join('');
    if (record.selection.kind === 'slices') {
      const captured = await operation.readSource(record.selection.source);
      const decoding = { kind: captured.decoding.kind, identity: captured.decoding.identity, encoding: captured.decoding.encoding };
      if (canonicalJSON(captured.identity) !== canonicalJSON(record.identity) ||
        descriptorGitMode(captured.fingerprint.mode) !== record.mode || canonicalJSON(decoding) !== canonicalJSON(record.decoding)) {
        throw new WorkspaceFailure('sourceChanged', record.selection.source);
      }
      content = captured.text;
    }
    const block = await operation.renderFileBlock({ kind: 'renderFileBlock', selectedPath: path,
      fileName: posix.basename(record.selection.source.path), content,
      ranges: record.selection.kind === 'slices' ? record.selection.ranges : null });
    return block.text;
  }
  #selectionFileEntry(record: Extract<Material['record'], { kind: 'source' }>, fields: SelectionReplyFile): SelectionReplyEntry {
    switch (record.selection.kind) {
      case 'codemap': return { ...fields, kind: 'codemap', origin: record.selectionOrigin === 'inferred' ? 'auto' : 'manual' };
      case 'slices': return { ...fields, kind: 'slice', ranges: record.selection.ranges };
      case 'full': return { ...fields, kind: 'full' };
    }
  }
  preview(input: DraftPreview, signal: AbortSignal, encode: ResultEncoding = identityEncoding) {
    if (!previewValidator.Check(input)) return Promise.reject(new WorkspaceFailure('invalidRequest'));
    const request = structuredClone(input);
    return this.#track((async () => {
      this.#check(signal, request.expectedRevision);
      const freezeGeneration = this.#freezeGeneration, current = this.#materials, prompt = this.#prompt;
      const { next, mode } = await this.#prepareSourceEdits(request.edits, current, request.expectedRevision, signal);
      this.#check(signal, request.expectedRevision);
      if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
      const rendered = renderBundle(await prepareRenderInput(this.operation.runtime, { request: this.request, inventory: this.operation.snapshot, prompt,
        codemapMode: mode, materials: [...next.values()] }, AbortSignal.any([signal, this.#cancel.signal])));
      this.#check(signal, request.expectedRevision);
      if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
      const result = { kind: 'preview' as const, draftId: this.id, revision: this.#revision, codemapMode: mode,
        items: [...next.values()].map(material => materialMetadata(material.record)),
        measurement: rendered.measurement, costs: rendered.costs, diagnostics: rendered.diagnostics };
      const requiredBytes = serializedBytes(encode(result));
      if (requiredBytes > request.maxOutputBytes) throw new WorkspaceFailure('outputBudgetTooSmall', { requiredBytes });
      return freeze(result);
    })());
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
    const snapshot = this.operation.snapshot;
    if (this.#structure?.digest !== snapshot.inventoryDigest) {
      this.#structure = { digest: snapshot.inventoryDigest, index: new StructureIndex(snapshot) };
    }
    const targets = this.#structure.index.resolveAutomaticCodemapTargets(seeds);
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
      const edits = mutation.kind === 'batch' ? mutation.edits : [mutation];
      ({ next, mode } = await this.#prepareSourceEdits(edits, current, input.expectedRevision, signal));
    }
    this.#check(signal, input.expectedRevision);
    if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
    const { changed, revision, result } = await this.#mutationReceipt(current, next, mode, prompt, input.maxOutputBytes, encode, promptResponse, signal);
    this.#check(signal, input.expectedRevision);
    if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
    if (changed) {
      this.#commit(next, mode, prompt, revision);
    }
    return freeze(result);
  }
  #commit(next: ReadonlyMap<string, Material>, mode: CodemapMode, prompt: string, revision: number): void {
    this.#materials = next; this.#codemapMode = mode; this.#prompt = prompt; this.#revision = revision;
  }
  #mutationChanges(current: ReadonlyMap<string, Material>, next: ReadonlyMap<string, Material>, mode: CodemapMode, prompt: string) {
    const changedIds = [...new Set([...current.keys(), ...next.keys()])].filter(id =>
      current.get(id) !== next.get(id) && canonicalJSON(current.get(id) ?? null) !== canonicalJSON(next.get(id) ?? null)).sort(compareBytes);
    const changed = changedIds.length > 0 || mode !== this.#codemapMode || prompt !== this.#prompt;
    const revision = this.#revision + (changed ? 1 : 0);
    return { changedIds, changed, revision };
  }
  async #mutationReceipt(current: ReadonlyMap<string, Material>, next: ReadonlyMap<string, Material>, mode: CodemapMode,
    prompt: string, maxOutputBytes: number, encode: ResultEncoding,
    promptResponse: { readonly op: 'set' | 'append' | 'clear'; readonly prompt: string } | null, signal: AbortSignal) {
    const { changedIds, changed, revision } = this.#mutationChanges(current, next, mode, prompt);
    const rendered = renderBundle(await prepareRenderInput(this.operation.runtime, { request: this.request, inventory: this.operation.snapshot, prompt,
      codemapMode: mode, materials: [...next.values()] }, AbortSignal.any([signal, this.#cancel.signal])));
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
  async #prepareSourceEdits(edits: readonly SourceEdit[], current: ReadonlyMap<string, Material>, revision: number, signal: AbortSignal) {
    const explicit = new Map([...current].filter(([, material]) =>
      material.record.kind !== 'source' || material.record.selectionOrigin === 'explicit'));
    let mode = this.#codemapMode;
    const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
    try {
      for (const edit of edits) {
        operation.signal.throwIfAborted();
        if (edit.kind === 'slices') {
          await this.#prepareSliceSource(edit, explicit, mode, operation);
        } else if (edit.kind === 'upsert' || edit.kind === 'remove') {
          let required: boolean;
          ({ required, mode } = this.#changeSourceIntent(edit, explicit, mode));
          if (edit.kind === 'upsert') {
            const prepared = await acquireSource(operation, { selectionOrigin: 'explicit', selection: edit.selection, required });
            explicit.set(prepared.record.id, prepared);
          }
        } else mode = this.#clearSourceIntent(edit.kind, explicit);
      }
      const next = await this.#derive(operation, explicit, mode, current, revision);
      return { next, mode };
    } finally { await operation.close(); }
  }
  async #prepareSliceSource(mutation: Extract<SourceEdit, { kind: 'slices' }>,
    explicit: Map<string, Material>, mode: CodemapMode, operation: WorkspaceOperation): Promise<void> {
    const id = sourceId(mutation.source);
    const entry = operation.snapshot.entries.find(item => item.root === mutation.source.root && item.path === mutation.source.path);
    if (entry?.kind !== 'file') throw new WorkspaceFailure('unavailableSource', mutation.source);
    const selected = explicit.get(id);
    const base = selected?.record.kind === 'source' && selected.record.selection.kind === 'slices' ? selected.record.selection.ranges : [];
    const op = mutation.op === 'add' ? 'coalesce' : mutation.op === 'remove' && mutation.ranges.length ? 'subtract' : 'normalize';
    const result = await operation.calculateSliceRanges({ kind: 'calculateSliceRanges', op, base, ranges: mutation.ranges });
    if (!result.ranges.length && (selected?.record.kind !== 'source' || selected.record.selection.kind !== 'slices')) return;
    const selection = result.ranges.length ? { kind: 'slices' as const, source: mutation.source, ranges: result.ranges }
      : { kind: 'full' as const, source: mutation.source };
    const { required } = this.#changeSourceIntent({ kind: 'upsert', selection }, explicit, mode);
    const prepared = await acquireSource(operation, { selectionOrigin: 'explicit', selection, required });
    explicit.set(id, prepared);
  }
  #changeSourceIntent(mutation: Extract<SourceMutation, { kind: 'upsert' | 'remove' }>, explicit: Map<string, Material>, mode: CodemapMode) {
    const id = sourceId(mutation.kind === 'upsert' ? mutation.selection.source : mutation.source);
    const selection = this.request.requiredSources.find(selection => sourceId(selection.source) === id);
    const required = selection !== undefined;
    if (selection && (mutation.kind === 'remove' || canonicalJSON(selection) !== canonicalJSON(mutation.selection))) {
      throw new WorkspaceFailure('requiredMaterialMutation', { id });
    }
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
  inspect(input: DraftInspection, signal: AbortSignal, encode: ResultEncoding = identityEncoding) {
    if (!inspectionValidator.Check(input)) throw new WorkspaceFailure('invalidRequest');
    return this.#track(this.#inspect(structuredClone(input), signal, encode));
  }
  async #inspect(input: DraftInspection, signal: AbortSignal, encode: ResultEncoding) {
    signal.throwIfAborted();
    const request = input;
    const { maxOutputBytes, continuation } = request;
    if (request.view === 'material') {
      const material = this.#materials.get(request.materialId);
      if (!material) throw new WorkspaceFailure('materialUnavailable', { id: request.materialId });
      const text = material.bodies.join('');
      const digest = sha256(canonicalJSON({ id: this.id, material: material.record, text }));
      return pageResult(
        prepareText(text).lines,
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
    const materials = [...this.#materials.values()], codemapMode = this.#codemapMode,
      revision = this.#revision, state = this.#state, text = this.#prompt;
    const rendered = renderBundle(await prepareRenderInput(this.operation.runtime, {
        codemapMode,
        request: this.request,
        inventory: this.operation.snapshot,
        prompt: text,
        materials,
      }, signal));
    const prompt = { kind: 'prompt' as const, prompt: text };
    const records: (ItemCost | ReturnType<typeof materialMetadata> | typeof prompt)[] = request.view === 'costs'
      ? rendered.costs
      : [...materials.map((material) => materialMetadata(material.record)), prompt];
    const digest = sha256(canonicalJSON({ id: this.id, revision, view: request.view,
      records, measurement: rendered.measurement }));
    return pageResult(
      records,
      pageOffset(continuation, digest),
      maxOutputBytes,
      (items, next) => ({
        kind: request.view,
        codemapMode,
        draftId: this.id,
        revision,
        state,
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
        material.record.kind === 'source' && material.record.selection.kind !== 'codemap' ? [material.record.selection.source] : []
      ),
    });
  }
  /** Read-only observation at invocation; JobRegistry captures it after admission and before dispatch. */
  initialContext(signal: AbortSignal): Promise<string> {
    return this.#track((async () => {
      this.#check(signal, this.#revision);
      const input = { request: this.request, inventory: this.operation.snapshot, materials: [...this.#materials.values()],
        prompt: this.#prompt, codemapMode: this.#codemapMode, draftId: this.id, revision: this.#revision,
        contextBudgetUnits: this.operation.runtime.options.contextBudgetUnits };
      const selection = this.selectionProjection();
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        const tree = await initialFileTree(operation, selection);
        return renderInitialContext({ ...await prepareRenderInput(this.operation.runtime, input, operation.signal),
          draftId: input.draftId, revision: input.revision, contextBudgetUnits: input.contextBudgetUnits, tree });
      } finally { await operation.close(); }
    })());
  }
  validate(signal: AbortSignal) {
    return this.#track((async () => {
      this.#check(signal, this.#revision);
      const revision = this.#revision, materials = [...this.#materials.values()], prompt = this.#prompt, codemapMode = this.#codemapMode;
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        await revalidateMaterials(operation, materials);
        const rendered = renderBundle(await prepareRenderInput(this.operation.runtime, {
          codemapMode,
          request: this.request,
          inventory: this.operation.snapshot,
          prompt,
          materials,
        }, operation.signal));
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
