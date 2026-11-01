import { randomUUID } from 'node:crypto';
import type { MipmuxRuntime, WorkspaceHandle } from './mipmux-runtime.js';
import type { WorkspaceSpec } from '../contracts/inventory.js';
import type { ContextBuildRequest, ContextPrepareRequest, DraftInspection, DraftUpdate } from '../contracts/context.js';
import type { DiscoveryCall } from '../contracts/discovery.js';
import type { DiscoveryRunner } from '../discovery/runner.js';
import type { DraftRuntime } from '../context/draft-runtime.js';
import type { JobSnapshot } from '../contracts/jobs.js';
import { JobRegistry } from './job-registry.js';
import { canonicalJSON, freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
import { observe } from '../workspace/observe.js';
import { expandCallerBuild, expandCallerPrepare, expandCallerWorkspace, type CallerBuildRequest, type CallerPrepareRequest,
  type CallerWorkspace } from '../contracts/caller-context.js';
import { scopedCall, scopedGitCall, scopedReadCall } from '../discovery/scoped-tools.js';
import { identityEncoding, type ResultEncoding } from '../exploration/output-budget.js';
import type { ClientQuestionResponse } from '../contracts/interaction.js';
import type { DiscoverySelection } from '../contracts/discovery.js';
import { listPromptPresets } from '../context/prompt-presets.js';
import { failureCode } from './tool-result.js';

type ExplorationCall = Exclude<DiscoveryCall, { name: 'ask_user' | 'draft_inspect' | 'draft_update' | 'draft_validate' | 'prompt' | 'manage_selection' }>;
interface ManualDraft { readonly workspaceId: string; readonly draft: DraftRuntime }

/** A connected client's handles and drafts are capabilities only within this owner. */
export class ClientRuntime {
  readonly #workspaces = new Map<string, WorkspaceHandle>();
  /** One admission per declaration that build and prepare calls name inline, retained until the client closes. */
  readonly #callerWorkspaces = new Map<string, Promise<WorkspaceHandle>>();
  readonly #drafts = new Map<string, ManualDraft>();
  readonly #jobs: JobRegistry;
  readonly #abort = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | null = null;
  constructor(private readonly runtime: MipmuxRuntime, runner: DiscoveryRunner | null, private readonly released: () => void) {
    this.#jobs = new JobRegistry(runner);
  }
  #check(): void { if (this.#abort.signal.aborted) throw new WorkspaceFailure('clientClosed'); }
  #workspace(id: string): WorkspaceHandle {
    this.#check();
    const workspace = this.#workspaces.get(id);
    if (!workspace) throw new WorkspaceFailure('unknownWorkspace');
    return workspace;
  }
  #manual(id: string): ManualDraft {
    this.#check();
    const draft = this.#drafts.get(id);
    if (!draft) throw new WorkspaceFailure('unknownManualDraft');
    return draft;
  }
  #track<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#check();
    const combined = AbortSignal.any([signal, this.#abort.signal]);
    combined.throwIfAborted();
    const promise = work(combined); this.#pending.add(promise);
    void promise.then(() => this.#pending.delete(promise), () => this.#pending.delete(promise));
    return promise;
  }
  /**
   * The retained handle for an inline declaration. Concurrent calls share one admission; cancelling `signal` ends only
   * this caller's observation. A failed admission is forgotten, so a later call admits the declaration again.
   */
  #callerWorkspace(input: CallerWorkspace, signal: AbortSignal): Promise<WorkspaceHandle> {
    const spec = expandCallerWorkspace(input), key = canonicalJSON(spec);
    const log = (level: string, outcome: string, fields: Record<string, string | null>) => process.stderr.write(JSON.stringify({
      level, event: 'callerWorkspace', outcome, declaration: sha256(key), ...fields }) + '\n');
    let admission = this.#callerWorkspaces.get(key);
    if (admission) log('debug', 'reused', {});
    else {
      const admitted = this.runtime.declare(spec, this.#abort.signal);
      this.#callerWorkspaces.set(key, admitted);
      admission = admitted;
      void admitted.then(workspace => log('debug', 'admitted', { workspaceKey: workspace.binding.workspaceKey }), error => {
        this.#callerWorkspaces.delete(key);
        log('error', 'failed', { code: failureCode(error) });
      });
    }
    return observe(admission, signal);
  }
  declare(spec: WorkspaceSpec, signal: AbortSignal) {
    return this.#track(signal, async combined => {
      const workspace = await this.runtime.declare(spec, combined), id = randomUUID();
      this.#workspaces.set(id, workspace); return { kind: 'workspace' as const, id };
    });
  }
  refresh(id: string, signal: AbortSignal) {
    const workspace = this.#workspace(id);
    return this.#track(signal, combined => workspace.refresh(combined));
  }
  closeWorkspace(id: string) { return this.#workspace(id).close(); }
  createDraft(id: string, request: ContextBuildRequest, signal: AbortSignal) {
    const workspace = this.#workspace(id);
    return this.#track(signal, async combined => {
      const draft = await workspace.createDraft(request, combined);
      this.#drafts.set(draft.id, { workspaceId: id, draft });
      return { kind: 'draft' as const, id: draft.id, revision: draft.revision };
    });
  }
  inspect(id: string, request: DraftInspection, signal: AbortSignal, encode: ResultEncoding = identityEncoding) {
    this.#check();
    const draft = this.#drafts.get(id)?.draft ?? this.#jobs.inspectDraft(id);
    return this.#track(signal, combined => draft.inspect(request, combined, encode));
  }
  update(id: string, request: DraftUpdate, signal: AbortSignal, encode: ResultEncoding = identityEncoding) {
    const { draft } = this.#manual(id);
    return this.#track(signal, combined => draft.update(request, combined, encode));
  }
  manageSelection(id: string, request: Parameters<DraftRuntime['manageSelection']>[0], signal: AbortSignal,
    encode: ResultEncoding = identityEncoding) {
    const { draft } = this.#manual(id);
    return this.#track(signal, combined => draft.manageSelection(request, combined, encode));
  }
  prompt(id: string | null, request: Parameters<DraftRuntime['prompt']>[0], signal: AbortSignal, encode: ResultEncoding = identityEncoding) {
    if (request.op === 'list_presets') return this.#track(signal, combined => listPromptPresets(this.runtime, combined, request.maxOutputBytes, encode));
    if (id === null) throw new WorkspaceFailure('draftRequired');
    const { draft } = this.#manual(id);
    return this.#track(signal, combined => draft.prompt(request, combined, encode));
  }
  validate(id: string, maxOutputBytes: number, signal: AbortSignal, encode: ResultEncoding = identityEncoding) {
    const { draft } = this.#manual(id);
    return this.#track(signal, combined => scopedCall({ name: 'draft_validate', input: { maxOutputBytes } }, draft, draft.operation, combined, encode));
  }
  /** Terminal outcomes release the draft's lease inside the draft owner; the draft remains inspectable. */
  finalize(id: string, signal: AbortSignal) {
    const { draft } = this.#manual(id);
    return this.#track(signal, combined => draft.finalize(combined));
  }
  /** Closes the manual draft and joins owner-scoped snapshot cleanup before forgetting its capability. */
  disposeDraft(id: string, signal: AbortSignal) {
    const { draft } = this.#manual(id);
    return this.#track(signal, async combined => {
      const result = await draft.dispose(combined);
      this.#drafts.delete(id);
      return result;
    });
  }
  explore(id: string, call: ExplorationCall, signal: AbortSignal,
    draftId: string | null = null, encode: ResultEncoding = identityEncoding) {
    const workspace = this.#workspace(id);
    const selected = draftId === null ? null : this.#manual(draftId);
    if (selected && selected.workspaceId !== id) throw new WorkspaceFailure('draftWorkspaceMismatch');
    return this.#track(signal, async combined => {
      const operation = selected ? await selected.draft.operation.fork(combined) : await workspace.openOperation(combined);
      try {
        switch (call.name) {
          case 'get_file_tree': {
            if (call.input.type === 'roots') return await operation.getFileTree({ ...call.input, selection: null }, encode);
            if (call.input.mode === 'selected' && !selected) throw new WorkspaceFailure('draftRequired');
            return await operation.getFileTree({ ...call.input, selection: selected?.draft.selectionProjection() ?? null }, encode);
          }
          case 'get_code_structure': return await operation.getCodeStructure({ ...call.input, selection: selected?.draft.selectionProjection() ?? null }, encode);
          case 'git': return await scopedGitCall(call.input, selected?.draft ?? null, operation, combined, encode);
          case 'read_file': return await scopedReadCall(call.input, selected?.draft ?? null, operation, combined, encode);
          case 'file_search': return await operation.fileSearch(call.input, encode);
        }
      } finally { await operation.close(); }
    });
  }
  /** Publishes a new bundle from a saved bundle beneath this workspace's output root, replacing only its prompt. */
  prepare(id: string, request: ContextPrepareRequest, signal: AbortSignal) {
    const workspace = this.#workspace(id);
    return this.#track(signal, combined => workspace.preparePacket(request, combined));
  }
  /** `prepare` for an inline declaration, which the client admits once and retains. */
  prepareContext(input: CallerPrepareRequest, signal: AbortSignal) {
    const captured = freeze(structuredClone(input)), request = expandCallerPrepare(captured);
    return this.#track(signal, async combined => (await this.#callerWorkspace(captured.workspace, combined)).preparePacket(request, combined));
  }
  /**
   * Enabled clarification requires the caller's form capability or throws elicitationUnavailable before admission. `discovery`
   * selects the job's discovery model and level from the allowed models, or throws modelNotAllowed before admission.
   */
  build(workspaceId: string, requestId: string, request: ContextBuildRequest, elicitation: 'form' | 'unavailable' = 'unavailable',
    discovery?: DiscoverySelection) {
    const workspace = this.#workspace(workspaceId);
    if (request.clarification && elicitation !== 'form') throw new WorkspaceFailure('elicitationUnavailable');
    return this.#jobs.start(workspace, { kind: 'requestId', workspaceId, requestId }, request, this.#jobs.settings(discovery));
  }
  /**
   * `build` for an inline declaration. The job is identified by its output destination: an identical start returns the
   * existing job, and the same destination with a different workspace, request or discovery settings fails with outputNameConflict.
   * Cancelling `signal` before the job is admitted starts nothing; afterwards the job runs until cancelled.
   */
  buildContext(input: CallerBuildRequest, signal: AbortSignal, elicitation: 'form' | 'unavailable') {
    const captured = freeze(structuredClone(input));
    const defaults = this.runtime.requestDefaults();
    const request = expandCallerBuild(captured, defaults.contextBudgetUnits, defaults.defaultEnhancementMode);
    if (request.clarification && elicitation !== 'form') throw new WorkspaceFailure('elicitationUnavailable');
    const settings = this.#jobs.settings(captured.discovery);
    return this.#track(signal, async combined => {
      const workspace = await this.#callerWorkspace(captured.workspace, combined);
      combined.throwIfAborted();
      return this.#jobs.start(workspace, { kind: 'destination', ...workspace.binding }, request, settings);
    });
  }
  /** Returns an owned job's current form, or null when no form is pending. */
  pendingQuestion(id: string) { this.#check(); return this.#jobs.pendingQuestion(id); }
  /** Consumes one current form response; stale or another job's question IDs fail before mutation. */
  answerQuestion(id: string, questionId: string, response: ClientQuestionResponse) {
    this.#check(); this.#jobs.answerQuestion(id, questionId, response);
  }
  result(id: string) { this.#check(); return this.#jobs.snapshot(id); }
  wait(id: string, durationMs: number, signal: AbortSignal, progress: (snapshot: JobSnapshot) => void) {
    return this.#track(signal, combined => this.#jobs.wait(id, durationMs, combined, progress));
  }
  cancel(id: string) { this.#check(); return this.#jobs.cancel(id); }
  /** Cancels or joins the job before disposing its draft snapshots; its terminal receipt and packet remain available. */
  disposeJob(id: string, signal: AbortSignal) {
    return this.#track(signal, combined => this.#jobs.dispose(id, combined));
  }
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#abort.abort();
      const results = await Promise.allSettled([this.#jobs.close()]);
      await Promise.allSettled([...this.#pending]);
      const admitted = await Promise.allSettled([...this.#callerWorkspaces.values()]);
      this.#callerWorkspaces.clear();
      results.push(...await Promise.allSettled([...this.#drafts.values()].map(({ draft }) => draft.close())));
      results.push(...await Promise.allSettled([...this.#workspaces.values()].map(workspace => workspace.close())));
      results.push(...await Promise.allSettled(admitted.flatMap(admission => admission.status === 'fulfilled' ? [admission.value.close()] : [])));
      this.released();
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return this.#closing;
  }
}
