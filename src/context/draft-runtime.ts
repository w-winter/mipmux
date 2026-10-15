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
import type { InventorySnapshot } from '../contracts/inventory.js';
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
import { prepareDiscoveryInput } from './discovery-input.js';
import { selectionValidator, type SelectionRequest } from '../contracts/selection.js';
import { prepareSelection, captureSelection, projectSelection, type CanonicalSelection, type SelectionState } from './selection-preparation.js';
import { prepareSourceEdits } from './draft-source-edits.js';
import { capturedArtifactSelection } from './git-artifact-selection.js';
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
import { registerPublishedGitArtifacts, readCatalogedGitArtifact, type CatalogedGitArtifact } from '../workspace/git-artifact-catalog.js';
import { acquireGitArtifact, refreshGitArtifactMaterials, type GitArtifactMaterial } from './git-artifact-material.js';
import { decorateGitPublicationReply } from './git-publication-reply.js';
import { ReadRequest } from '../contracts/exploration.js';
import { readFileReply } from '../exploration/read.js';
import type { AutomaticCodemapOutcome } from '../contracts/automatic-codemaps.js';
import { acquireAutomaticCodemaps, automaticAcquisitionSummary, automaticCodemapDisposition, type DerivedMaterials } from './automatic-codemap-acquisition.js';

const promptValidator = Compile(PromptRequestSchema), previewValidator = Compile(DraftPreview);
const snapshotPublicationValidator = Compile(GitSnapshotPublicationOptions);
const artifactReadValidator = Compile(ReadRequest.anyOf[1]);
const gitArtifactEffectFailures = new Set(['revisionConflict', 'draftFrozen', 'gitRepositoryChanged', 'gitSelectionOwnershipChanged',
  'gitArtifactNotCataloged', 'gitArtifactUnauthorized', 'pathDenied', 'notFound', 'permissionDenied', 'symlink', 'nonRegularFile',
  'rootChanged', 'outputChanged', 'nativeIOFailed', 'invalidEncoding']);
const gitArtifactReadFailures = new Set(['gitArtifactNotCataloged', 'gitArtifactUnauthorized', 'gitRepositoryChanged',
  'pathDenied', 'notFound', 'permissionDenied', 'symlink', 'nonRegularFile', 'rootChanged', 'outputChanged', 'nativeIOFailed', 'invalidEncoding']);
type SelectionReplyEntry = Static<typeof NativeSelectionReplyInput>['entries'][number];
type SelectionReplyFile = Omit<Extract<SelectionReplyEntry, { kind: 'full' }>, 'kind'>;

export class DraftRuntime {
  readonly id = randomUUID();
  #materials: ReadonlyMap<string, Material> = new Map();
  #automaticCodemaps: readonly AutomaticCodemapOutcome[] = [];
  #selection: CanonicalSelection;
  get #codemapMode(): CodemapMode { return this.#selection.state.codemapAutoEnabled ? 'automatic' : 'manual'; }
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
  #gitAdvertisements: ReadonlyMap<string, CatalogedGitArtifact> = new Map();
  private constructor(
    readonly operation: WorkspaceOperation,
    readonly request: ContextBuildRequest,
    private readonly onClosed: () => void,
    private readonly gitTarget: FrozenGitTarget,
    selection: CanonicalSelection,
  ) {
    this.#selection = freeze(selection);
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
    request.contextBuilderPrompts?.forEach(prompt => { strictText(prompt.title); strictText(prompt.content); });
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
      const mode = request.requiredSources.some(selection => selection.kind === 'codemap') ? 'manual' : request.initialSelection.codemapMode;
      const draft = new DraftRuntime(operation, request, onClosed, target, await captureSelection(admission, materials, mode));
      const derived = await draft.#derive(admission, materials, draft.#codemapMode, 0);
      draft.#materials = derived.materials; draft.#automaticCodemaps = derived.automaticCodemaps;
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
  /** Captures paths once, retaining frozen ownership and lifecycle fences while later selection edits proceed. */
  captureGitPublication(input: Extract<GitRequest, { op: 'diff' }>, generateDiffText: boolean,
    scope: Static<typeof GitSnapshotPublicationOptions>['scope'], signal: AbortSignal) {
    const request = structuredClone(input), current = this.#materials;
    return this.#track((async () => {
      this.#check(signal, this.#revision);
      const generation = this.#freezeGeneration;
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        const checkout = await this.gitTarget.publication(operation, current, request);
        this.#check(signal, this.#revision);
        if (generation !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
        const paths = scope === 'selected' ? selectedGitSourcePaths(operation, current) : null;
        const captured = await captureElectedGitDiff(operation, request, checkout, generateDiffText, paths);
        this.#check(signal, this.#revision);
        if (generation !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
        return { ...captured, checkout };
      } finally { await operation.close(); }
    })());
  }
  /** Publishes snapshots and replaces exact catalog-ready read grants. */
  publishGitSnapshot(input: Extract<GitRequest, { op: 'diff' }>, options: Static<typeof GitSnapshotPublicationOptions>, signal: AbortSignal) {
    const current = this.#materials, generation = this.#freezeGeneration;
    return this.#track((async () => {
      const prepared = await this.#prepareGitSnapshot(input, options, signal, current, generation);
      this.#check(signal, this.#revision);
      this.#installGitAdvertisements(prepared.advertisements);
      return prepared.published;
    })());
  }
  async #prepareGitSnapshot(input: Extract<GitRequest, { op: 'diff' }>, options: Static<typeof GitSnapshotPublicationOptions>,
    signal: AbortSignal, current: ReadonlyMap<string, Material>, generation: number) {
    const request = structuredClone(input), parsed = snapshotPublicationValidator.Parse(structuredClone(options));
    const id = parsed.snapshotID?.trim();
    const capturedOptions = { ...parsed, snapshotID: id && id.toLowerCase() !== 'auto' ? id : null,
      inlineMode: parsed.inlineMode.toLowerCase(), inlineMaxLines: Math.max(1, parsed.inlineMaxLines) };
    this.#check(signal, this.#revision);
    const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
    const check = () => {
      this.#check(signal, this.#revision);
      if (generation !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
    };
    try {
      const checkouts = await this.gitTarget.publicationRepositories(operation, current, request);
      check();
      const publishSingle = async () => {
        const checkout = checkouts[0];
        if (!checkout) throw new WorkspaceFailure('gitPublicationTargetDenied');
        const repository = await resolveDiffRepository(operation, checkout.root, { kind: 'elected', checkout });
        const prepared = await prepareGitPublicationMetadata(operation, checkout, repository);
        const paths = capturedOptions.scope === 'selected' ? selectedGitSourcePaths(operation, current) : null;
        const captured = await captureElectedGitDiff(operation, request, checkout, capturedOptions.mode !== 'quick', paths);
        check();
        return publishGitSnapshot(operation, { ...captured, checkout }, request, capturedOptions, this.id, check, prepared);
      };
      let published = checkouts.length > 1
        ? await publishGitSnapshotBatch(operation, checkouts, selectedGitSourcePaths(operation, current),
          request, capturedOptions, this.id, check)
        : await publishSingle();
      check();
      await this.gitTarget.publicationRepositories(operation, current, request);
      const advertisements = new Map<string, CatalogedGitArtifact>(), readinessWarnings: Record<string, string> = {};
      for (const item of published.kind === 'single' ? [published] : published.publications) {
        const readiness = await registerPublishedGitArtifacts(operation, item, this.id);
        for (const entry of readiness.ready) {
          const alias = entry.artifact.clientAlias;
          if (alias === null) throw new WorkspaceFailure('nativeProtocolError');
          advertisements.set(alias, entry);
        }
        if (readiness.warning !== null) readinessWarnings[item.snapshotDir] = readiness.warning;
      }
      published = await decorateGitPublicationReply(operation, published, [], readinessWarnings);
      check();
      await this.gitTarget.publicationRepositories(operation, current, request);
      check();
      return { published, advertisements };
    } finally { await operation.close(); }
  }
  #installGitAdvertisements(advertisements: ReadonlyMap<string, CatalogedGitArtifact>) {
    this.#gitAdvertisements = advertisements;
    process.stderr.write(JSON.stringify({ level: 'info', event: 'gitArtifactGrantsReplaced', draftId: this.id,
      revision: this.#revision, aliases: advertisements.size }) + '\n');
  }
  async #commitGitSelection(operation: WorkspaceOperation, primary: ReadonlyMap<string, GitArtifactMaterial>,
    captured: ReadonlyMap<string, Material>, capturedSelection: CanonicalSelection, generation: number) {
    for (;;) {
      this.#check(operation.signal, this.#revision);
      if (generation !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
      const revision = this.#revision, latest = this.#materials, prompt = this.#prompt;
      const merged = await operation.transitionSelection({ kind: 'transitionSelection', selection: this.#selection.state,
        mutation: { kind: 'gitPublication', contextSelection: capturedSelection.state } });
      const state = { ...merged.selection, selectedPaths: [...merged.selection.selectedPaths] };
      const aliases: string[] = [];
      for (const material of primary.values()) {
        if (state.selectedPaths.includes(material.record.reference.absolutePath)) continue;
        state.selectedPaths.push(material.record.reference.absolutePath); aliases.push(material.record.reference.alias);
      }
      const known = capturedArtifactSelection(new Map([...primary, ...captured, ...latest])).known;
      const projection = projectSelection({ roots: capturedSelection.roots, state }, known);
      const next = await this.#prepareResolvedSelection(operation, projection, latest, [latest, captured, primary], revision);
      this.#check(operation.signal, this.#revision);
      if (generation !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
      // Repeat only preparation when another edit commits during the native projection or acquisition.
      if (revision !== this.#revision) continue;
      const candidate = this.#mutationChanges(latest, next.materials, state, prompt);
      if (candidate.changed) this.#commit(next.materials, state, prompt, candidate.revision, next.automaticCodemaps);
      return { revision: candidate.revision, aliases };
    }
  }
  /** Commits mutable primary selection before reply admission; insertion grants are installed only after encoding succeeds. */
  publishGitArtifacts(input: Extract<GitRequest, { op: 'diff'; artifacts: true }>, signal: AbortSignal, encode: ResultEncoding) {
    const request = structuredClone(input), revision = this.#revision, generation = this.#freezeGeneration,
      captured = this.#materials, capturedSelection = this.#selection;
    return this.#track((async () => {
      this.#check(signal, revision);
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        const normalized = await operation.gitDiffOperation({ kind: 'normalizeGitPublicationOptions', mode: request.mode,
          scope: request.scope, snapshotID: request.snapshot_id, inlineMap: request.inline.map,
          inlineMode: request.inline.mode, inlineMaxLines: request.inline.max_lines });
        if (normalized.kind === 'gitPublicationOptionsError') throw new WorkspaceFailure('invalidRequest', { message: normalized.message });
        const prepared = await this.#prepareGitSnapshot(request, normalized.options, signal, captured, generation);
        const primary = new Map<string, GitArtifactMaterial>(), autoSelected: string[] = [], commitWarnings: Record<string, string> = {};
        let committedRevision = revision;
        try {
          for (const entry of prepared.advertisements.values()) {
            if (entry.artifact.selectionDisposition !== 'primaryAutoSelect') continue;
            const material = await acquireGitArtifact(operation, entry);
            primary.set(material.record.id, material);
          }
          const committed = await this.#commitGitSelection(operation, primary, captured, capturedSelection, generation);
          committedRevision = committed.revision; autoSelected.push(...committed.aliases);
        } catch (error) {
          operation.signal.throwIfAborted();
          const code = failureCode(error);
          if (!gitArtifactEffectFailures.has(code)) throw error;
          autoSelected.length = 0; committedRevision = this.#revision;
          for (const entry of prepared.advertisements.values()) if (entry.artifact.selectionDisposition === 'primaryAutoSelect') {
            commitWarnings[entry.snapshotDir] = 'Git artifact readiness: cataloged primary artifacts could not be committed to the canonical draft selection (' + code + '); autoSelected was omitted.';
          }
          process.stderr.write(JSON.stringify({ level: 'warn', event: 'gitPrimaryArtifactCommitRejected', draftId: this.id, code }) + '\n');
        }
        const decorated = await decorateGitPublicationReply(operation, prepared.published, autoSelected, commitWarnings);
        const reply = decorated.projection.reply;
        operation.signal.throwIfAborted();
        const requiredBytes = serializedBytes(encode(reply));
        if (requiredBytes > request.maxOutputBytes) throw new WorkspaceFailure('outputBudgetTooSmall', { requiredBytes });
        try {
          this.#check(signal, committedRevision);
          if (generation !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
          await this.gitTarget.publicationRepositories(operation, this.#materials, request);
          for (const entry of prepared.advertisements.values()) await readCatalogedGitArtifact(operation, entry);
          this.#check(signal, committedRevision);
          if (generation !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
          this.#installGitAdvertisements(prepared.advertisements);
        } catch (error) {
          operation.signal.throwIfAborted();
          const code = failureCode(error);
          if (!gitArtifactEffectFailures.has(code)) throw error;
          this.#installGitAdvertisements(new Map());
          process.stderr.write(JSON.stringify({ level: 'warn', event: 'gitArtifactGrantInstallationRejected', draftId: this.id, code }) + '\n');
        }
        return reply;
      } finally { await operation.close(); }
    })());
  }
  /** Exact current advertisement lookup. Replacing a grant while a read is pending invalidates that read. */
  readGitArtifact(alias: string, signal: AbortSignal) {
    return this.#track((async () => {
      this.#check(signal, this.#revision);
      const grant = this.#gitAdvertisements, entry = grant.get(alias);
      if (!entry) throw new WorkspaceFailure('gitArtifactNotAdvertised');
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        const result = await readCatalogedGitArtifact(operation, entry);
        this.#check(signal, this.#revision);
        if (grant !== this.#gitAdvertisements) throw new WorkspaceFailure('gitArtifactAdvertisementChanged');
        return result;
      } finally { await operation.close(); }
    })());
  }
  /** Reads captured selected aliases under historical artifact authority, independent of current insertion grants. */
  readSelectedGitArtifact(input: Extract<ReadRequest, { root: null }>, signal: AbortSignal, encode: ResultEncoding) {
    if (!artifactReadValidator.Check(input)) return Promise.reject(new WorkspaceFailure('invalidRequest'));
    const request = structuredClone(input);
    return this.#track((async () => {
      this.#check(signal, this.#revision);
      const selected = this.#materials.get('gitArtifact:' + request.path);
      const denied = new WorkspaceFailure('gitArtifactReadDenied', {
        message: "Cannot read '" + request.path + "'. Git-data artifacts must already be selected and authorized.",
      });
      if (!selected || selected.availability !== 'settled' || (selected.record.kind !== 'gitMap' && selected.record.kind !== 'gitPatch')) {
        throw denied;
      }
      const reference = selected.record.reference;
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        let body: Awaited<ReturnType<typeof readCatalogedGitArtifact>>;
        try {
          const entry = operation.catalogedGitArtifact(reference.absolutePath);
          if (!entry) throw new WorkspaceFailure('gitArtifactNotCataloged');
          body = await readCatalogedGitArtifact(operation, { ...entry, ...reference });
        } catch (error) {
          operation.signal.throwIfAborted();
          const code = failureCode(error);
          if (!gitArtifactReadFailures.has(code)) throw error;
          process.stderr.write(JSON.stringify({ level: 'warn', event: 'gitArtifactReadRejected', draftId: this.id,
            alias: request.path, code }) + '\n');
          throw denied;
        }
        const reply = await readFileReply(operation, request, body, encode);
        this.#check(signal, this.#revision);
        return reply;
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
      const freezeGeneration = this.#freezeGeneration, current = this.#materials, prompt = this.#prompt, selection = this.#selection,
        grants = this.#gitAdvertisements;
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        const prepared = await prepareSelection(operation, request, current, selection, grants);
        const derived = request.op === 'get' ? await this.#derive(operation,
          new Map([...current].filter(([, material]) => material.record.kind !== 'source' || material.record.selectionOrigin === 'explicit')),
          prepared.mode, revision)
          : await this.#prepareResolvedSelection(operation, prepared, current, [current], revision);
        const next = derived.materials;
        const candidate = this.#mutationChanges(current, next, prepared.state, this.#prompt);
        const isMutation = request.op !== 'get' && request.op !== 'preview';
        this.#check(signal, revision);
        if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
        if (prepared.usesInsertionGrant && grants !== this.#gitAdvertisements) throw new WorkspaceFailure('gitArtifactAdvertisementChanged');
        if (isMutation && candidate.changed) {
          this.#commit(next, prepared.state, this.#prompt, candidate.revision, derived.automaticCodemaps);
        }
        const settled = await resolveSelectedCodemaps(operation, next);
        operation.signal.throwIfAborted();
        if (request.op === 'get') this.#retainRefreshedPresentation(current, settled, derived.automaticCodemaps, revision, freezeGeneration);
        else if (request.op !== 'preview') this.#retainCodemapPresentation(next, settled);
        const reply = await this.#selectionReply(operation, request, settled, prepared.mode, prepared.invalid,
          isMutation ? candidate.revision : revision, prompt, derived.automaticCodemaps);
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
  async #prepareResolvedSelection(operation: WorkspaceOperation, prepared: ReturnType<typeof projectSelection>,
    current: ReadonlyMap<string, Material>, candidates: readonly ReadonlyMap<string, Material>[], revision: number): Promise<DerivedMaterials> {
    const explicit = new Map([...current].filter(([, material]) => material.record.kind !== 'source'
      && material.record.kind !== 'gitMap' && material.record.kind !== 'gitPatch'));
    for (const required of this.request.requiredSources) {
      if (!prepared.selections.some(selection => canonicalJSON(selection) === canonicalJSON(required))) {
        throw new WorkspaceFailure('requiredMaterialMutation', { id: sourceId(required.source) });
      }
    }
    for (const selection of prepared.selections) {
      const id = sourceId(selection.source);
      const existing = candidates.map(candidate => candidate.get(id)).find(material => material?.record.kind === 'source'
        && material.record.selectionOrigin === 'explicit' && canonicalJSON(material.record.selection) === canonicalJSON(selection));
      const required = this.request.requiredSources.some(required => sourceId(required.source) === id);
      const material = existing ? existing
        : selection.kind === 'codemap' && !required ? await prepareCodemapSelection(operation, selection)
        : await acquireSource(operation, { selectionOrigin: 'explicit', selection, required });
      explicit.set(id, material);
    }
    for (const material of prepared.artifactMaterials) explicit.set(material.record.id, material);
    return this.#derive(operation, explicit, prepared.mode, revision);
  }
  #retainCodemapPresentation(pending: ReadonlyMap<string, Material>, settled: ReadonlyMap<string, Material>): void {
    if (this.#closing || this.#state !== 'editable') return;
    const next = new Map(this.#materials);
    for (const [id, material] of settled) {
      const previous = pending.get(id);
      if (previous && next.get(id) === previous) {
        next.set(id, material);
      }
    }
    this.#materials = next;
  }
  #retainRefreshedPresentation(captured: ReadonlyMap<string, Material>, settled: ReadonlyMap<string, Material>,
    outcomes: readonly AutomaticCodemapOutcome[], revision: number, generation: number): void {
    if (this.#closing || this.#state !== 'editable' || this.#materials !== captured || this.#revision !== revision || this.#freezeGeneration !== generation) return;
    const next = new Map(captured);
    for (const id of next.keys()) if (!settled.has(id)) next.delete(id);
    for (const [id, material] of settled) next.set(id, material);
    this.#materials = next; this.#automaticCodemaps = outcomes;
  }
  #automaticPresentationPaths(snapshot: InventorySnapshot, display: SelectionRequest['path_display'], outcomes: readonly AutomaticCodemapOutcome[]) {
    const unmapped: string[] = [], pending: string[] = [];
    for (const item of outcomes) {
      const disposition = automaticCodemapDisposition(item);
      if (disposition === null) continue;
      const root = snapshot.roots.find(root => root.name === item.source.root)!;
      const path = display === 'full' ? posix.join(root.identity.canonicalPath, item.source.path)
        : snapshot.roots.length === 1 ? item.source.path : root.name + '/' + item.source.path;
      (disposition === 'pending' ? pending : unmapped).push(path);
    }
    return { unmapped, pending };
  }
  async #selectionReply(operation: WorkspaceOperation, request: SelectionRequest, materials: ReadonlyMap<string, Material>, mode: CodemapMode,
    invalid: readonly string[], revision: number, prompt: string, automaticCodemaps: readonly AutomaticCodemapOutcome[]) {
    const observed = await refreshGitArtifactMaterials(operation, [...materials.values()]);
    const snapshot = operation.snapshot;
    const rendered = renderBundle(await prepareRenderInput(this.operation.runtime, { request: this.request, inventory: snapshot,
      prompt, codemapMode: mode, materials: observed }, operation.signal));
    const { unmapped, pending } = this.#automaticPresentationPaths(snapshot, request.path_display, automaticCodemaps);
    const entries: Static<typeof NativeSelectionReplyInput>['entries'] = [];
    const blocks: string[] = [];
    for (const material of observed) {
      const record = material.record;
      if (record.kind === 'gitMap' || record.kind === 'gitPatch') {
        const path = request.path_display === 'full' ? record.reference.absolutePath : record.reference.alias;
        entries.push({ kind: 'full', path, tokens: estimateUnits(Buffer.byteLength(material.bodies.join(''))),
          rootPath: '_git_data', pathWithinRoot: record.reference.snapshotDir + '/' + record.reference.path });
        if (request.view === 'content') {
          const block = await operation.renderFileBlock({ kind: 'renderFileBlock', selectedPath: path,
            fileName: posix.basename(record.reference.path), content: material.bodies.join(''), ranges: null });
          blocks.push(block.text);
        }
        continue;
      }
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
      const { next, mode, automaticCodemaps } = await this.#prepareSourceEdits(request.edits, current, request.expectedRevision, signal);
      this.#check(signal, request.expectedRevision);
      if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
      const observed = await this.#liveMaterials([...next.values()], signal);
      const rendered = renderBundle(await prepareRenderInput(this.operation.runtime, { request: this.request, inventory: this.operation.snapshot, prompt,
        codemapMode: mode, materials: observed }, AbortSignal.any([signal, this.#cancel.signal])));
      this.#check(signal, request.expectedRevision);
      if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
      const result = { kind: 'preview' as const, draftId: this.id, revision: this.#revision, codemapMode: mode,
        automaticAcquisition: automaticAcquisitionSummary(automaticCodemaps),
        items: observed.map(material => materialMetadata(material.record)),
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
    revision: number): Promise<DerivedMaterials> {
    if (mode === 'manual') return { materials: explicit, automaticCodemaps: [] };
    const seeds = [...explicit.values()].flatMap(({ record }) =>
      record.kind === 'source' && record.selection.kind !== 'codemap' ? [record.selection.source] : []);
    if (!seeds.length) return { materials: explicit, automaticCodemaps: [] };
    const snapshot = this.operation.snapshot;
    if (this.#structure?.digest !== snapshot.inventoryDigest) {
      this.#structure = { digest: snapshot.inventoryDigest, index: new StructureIndex(snapshot) };
    }
    const resolution = this.#structure.index.resolveAutomaticCodemapTargets(seeds);
    if (resolution.kind === 'targetDemandLimit') {
      process.stderr.write(JSON.stringify({ level: 'warn', event: 'automaticCodemapDemandRejected', draftId: this.id,
        revision, inventoryDigest: snapshot.inventoryDigest, attempted: resolution.attempted, limit: resolution.limit }) + '\n');
    }
    if (resolution.kind === 'queryBudget') for (const rejection of resolution.rejections) {
      process.stderr.write(JSON.stringify({ level: 'warn', event: 'automaticCodemapQueryRejected', draftId: this.id,
        revision, inventoryDigest: snapshot.inventoryDigest, ...rejection }) + '\n');
    }
    return acquireAutomaticCodemaps(operation, explicit, resolution.targets, { draftId: this.id, revision });
  }
  async #update(input: DraftUpdate, signal: AbortSignal, encode: ResultEncoding,
    promptResponse: { readonly op: 'set' | 'append' | 'clear'; readonly prompt: string } | null = null) {
    this.#check(signal, input.expectedRevision);
    const freezeGeneration = this.#freezeGeneration, current = this.#materials;
    const mutation = input.mutation;
    let next: ReadonlyMap<string, Material> = current, state = this.#selection.state, prompt = this.#prompt;
    let automaticCodemaps = this.#automaticCodemaps;
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
      ({ next, state, automaticCodemaps } = await this.#prepareSourceEdits(edits, current, input.expectedRevision, signal));
    }
    this.#check(signal, input.expectedRevision);
    if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
    const { changed, revision, result } = await this.#mutationReceipt(current, next, state, prompt, input.maxOutputBytes, encode, promptResponse, signal, automaticCodemaps);
    this.#check(signal, input.expectedRevision);
    if (freezeGeneration !== this.#freezeGeneration) throw new WorkspaceFailure('draftFrozen');
    if (changed) {
      this.#commit(next, state, prompt, revision, automaticCodemaps);
    }
    return freeze(result);
  }
  #commit(next: ReadonlyMap<string, Material>, state: SelectionState, prompt: string, revision: number, automaticCodemaps: readonly AutomaticCodemapOutcome[]): void {
    this.#materials = next; this.#selection = freeze({ roots: this.#selection.roots, state }); this.#prompt = prompt; this.#revision = revision;
    this.#automaticCodemaps = automaticCodemaps;
  }
  #mutationChanges(current: ReadonlyMap<string, Material>, next: ReadonlyMap<string, Material>, state: SelectionState, prompt: string) {
    const changedIds = [...new Set([...current.keys(), ...next.keys()])].filter(id =>
      current.get(id) !== next.get(id) && canonicalJSON(current.get(id) ?? null) !== canonicalJSON(next.get(id) ?? null)).sort(compareBytes);
    const changed = changedIds.length > 0 || canonicalJSON(state) !== canonicalJSON(this.#selection.state) || prompt !== this.#prompt;
    const revision = this.#revision + (changed ? 1 : 0);
    return { changedIds, changed, revision };
  }
  async #mutationReceipt(current: ReadonlyMap<string, Material>, next: ReadonlyMap<string, Material>, state: SelectionState,
    prompt: string, maxOutputBytes: number, encode: ResultEncoding,
    promptResponse: { readonly op: 'set' | 'append' | 'clear'; readonly prompt: string } | null, signal: AbortSignal, automaticCodemaps: readonly AutomaticCodemapOutcome[]) {
    const { changedIds, changed, revision } = this.#mutationChanges(current, next, state, prompt);
    const mode = state.codemapAutoEnabled ? 'automatic' as const : 'manual' as const;
    const observed = await this.#liveMaterials([...next.values()], signal);
    const rendered = renderBundle(await prepareRenderInput(this.operation.runtime, { request: this.request, inventory: this.operation.snapshot, prompt,
      codemapMode: mode, materials: observed }, AbortSignal.any([signal, this.#cancel.signal])));
    const changedSet = new Set(changedIds);
    const changedCosts = rendered.costs.filter(cost => changedSet.has(cost.id));
    for (const id of changedIds) if (!next.has(id)) changedCosts.push({ id, bytes: 0, units: 0 });
    changedCosts.sort((a, b) => compareBytes(a.id, b.id));
    const receipt = (costs: typeof changedCosts, incompleteDetails: boolean) => ({
      kind: 'mutation' as const, revision, codemapMode: mode, changedCosts: costs, incompleteDetails,
      automaticAcquisition: automaticAcquisitionSummary(automaticCodemaps),
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
    const selection = this.#selection;
    const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
    try {
      const { explicit, state, mode } = await prepareSourceEdits(operation, edits, current, selection, this.request.requiredSources);
      const derived = await this.#derive(operation, explicit, mode, revision);
      return { next: derived.materials, automaticCodemaps: derived.automaticCodemaps, state, mode };
    } finally { await operation.close(); }
  }
  inspect(input: DraftInspection, signal: AbortSignal, encode: ResultEncoding = identityEncoding) {
    if (!inspectionValidator.Check(input)) throw new WorkspaceFailure('invalidRequest');
    return this.#track(this.#inspect(structuredClone(input), signal, encode));
  }
  async #liveMaterials(materials: readonly Material[], signal: AbortSignal): Promise<readonly Material[]> {
    if (this.#state === 'terminal' || !materials.some(({ record }) => record.kind === 'gitMap' || record.kind === 'gitPatch')) return materials;
    const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
    try { return await refreshGitArtifactMaterials(operation, materials); }
    finally { await operation.close(); }
  }
  async #inspect(input: DraftInspection, signal: AbortSignal, encode: ResultEncoding) {
    signal.throwIfAborted();
    const request = input;
    const { maxOutputBytes, continuation } = request;
    if (request.view === 'material') {
      const material = this.#materials.get(request.materialId);
      if (!material) throw new WorkspaceFailure('materialUnavailable', { id: request.materialId });
      const observed = (await this.#liveMaterials([material], signal))[0]!;
      const text = observed.bodies.join('');
      const digest = sha256(canonicalJSON({ id: this.id, material: observed.record, text }));
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
    const captured = [...this.#materials.values()], codemapMode = this.#codemapMode,
      revision = this.#revision, state = this.#state, text = this.#prompt;
    const materials = await this.#liveMaterials(captured, signal);
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
    return this.#initialObservation(signal).then(view => view.context);
  }
  discoveryInput(signal: AbortSignal) {
    return this.#track((async () => prepareDiscoveryInput(this.operation.runtime, this.request,
      await this.#initialObservation(signal), this.gitTarget.restrictsGitToExplicitReadOnly, signal))());
  }
  #initialObservation(signal: AbortSignal) {
    return this.#track((async () => {
      this.#check(signal, this.#revision);
      const input = { request: this.request, inventory: this.operation.snapshot, materials: [...this.#materials.values()],
        prompt: this.#prompt, codemapMode: this.#codemapMode, draftId: this.id, revision: this.#revision,
        contextBudgetUnits: this.operation.runtime.options.contextBudgetUnits };
      const selection = this.selectionProjection();
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        const tree = await initialFileTree(operation, selection);
        const materials = await refreshGitArtifactMaterials(operation, input.materials);
        const context = renderInitialContext({ ...await prepareRenderInput(this.operation.runtime, { ...input, materials }, operation.signal),
          draftId: input.draftId, revision: input.revision, contextBudgetUnits: input.contextBudgetUnits, tree });
        return { context, tree, prompt: input.prompt, roots: input.inventory.roots.map(root => root.name) };
      } finally { await operation.close(); }
    })());
  }
  validate(signal: AbortSignal) {
    return this.#track((async () => {
      this.#check(signal, this.#revision);
      const revision = this.#revision, captured = [...this.#materials.values()], prompt = this.#prompt, codemapMode = this.#codemapMode;
      const operation = await this.operation.fork(AbortSignal.any([signal, this.#cancel.signal]));
      try {
        const materials = await refreshGitArtifactMaterials(operation, captured);
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
      this.#automaticCodemaps,
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
      this.#materials = new Map(operation.capturedMaterials.map(material => [material.record.id, material]));
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
      this.#materials = new Map(operation.capturedMaterials.map(material => [material.record.id, material]));
      await terminal();
      throw error;
    });
    return this.#finalized;
  }
  cancelFinalization() {
    return this.#finalization?.cancel() ?? { kind: 'notFinalizing' as const };
  }
  /** Joins owned work, then removes snapshots whose current manifest names this draft; ordinary close retains them. */
  async dispose(signal: AbortSignal) {
    signal.throwIfAborted();
    const root = this.operation.snapshot.outputRoot;
    await this.close();
    signal.throwIfAborted();
    return this.operation.runtime.mutateGitSnapshots(root, signal, async (combined, access) => {
      const result = await access.bridge.request({ kind: 'maintainGitSnapshots', root: access.root,
        action: { kind: 'closed', tabIDs: [this.id] } }, combined);
      const outcome = result.result.outcome;
      if (!('deleted' in outcome)) throw new WorkspaceFailure('nativeProtocolError');
      process.stderr.write(JSON.stringify({ level: 'info', event: 'contextSnapshotsDisposed', draftId: this.id,
        deletedSnapshots: outcome.deleted }) + '\n');
      return { kind: 'disposed' as const, draftId: this.id, deletedSnapshots: outcome.deleted };
    });
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
