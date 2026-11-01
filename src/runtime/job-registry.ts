import { randomUUID } from 'node:crypto';
import type { WorkspaceBinding, WorkspaceHandle } from './mipmux-runtime.js';
import type { DraftRuntime } from '../context/draft-runtime.js';
import type { ContextBuildRequest } from '../contracts/context.js';
import { contextRequestValidator } from '../contracts/context.js';
import type { DiscoveryCall, DiscoveryReceipt, DiscoveryEvent } from '../contracts/discovery.js';
import type { JobPhase, JobSnapshot, JobTerminal } from '../contracts/jobs.js';
import type { DiscoveryRunner } from '../discovery/runner.js';
import type { DiscoverySettings } from '../discovery/selection.js';
import type { DiscoverySelection } from '../contracts/discovery.js';
import { canonicalJSON, freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
import { scopedCall } from '../discovery/scoped-tools.js';
import { cacheRecoveryTarget, failureCode } from './tool-result.js';
import { defaultQuestionTimeoutSeconds, type AskUserRequest, type ClientQuestionResponse, type PendingQuestion } from '../contracts/interaction.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';

type QuestionResponse = ClientQuestionResponse | { readonly action: 'timeout' };
/**
 * What makes a start a retry. A library caller names a request ID within its workspace handle; an MCP caller's output
 * destination, the admitted output directory and the request's `outputName`, identifies its job for the connection.
 */
export type JobIdentity = { readonly kind: 'requestId'; readonly workspaceId: string; readonly requestId: string } |
  ({ readonly kind: 'destination' } & WorkspaceBinding);

/** A discovery call's tool name and the fields that say how it changes the draft. */
function callSummary(call: DiscoveryCall) {
  switch (call.name) {
    case 'manage_selection': return { name: call.name, op: call.input.op, mode: call.input.mode, paths: call.input.paths.length };
    case 'draft_update': return { name: call.name, mutation: call.input.mutation.kind };
    case 'prompt': return { name: call.name, op: call.input.op };
    default: return { name: call.name };
  }
}
type QuestionState = { readonly kind: 'idle' } | { readonly kind: 'preparing' | 'answering'; readonly id: string } |
  { readonly kind: 'pending'; readonly question: PendingQuestion; readonly respond: (response: ClientQuestionResponse) => boolean };
// Node treats larger setTimeout delays as 1 ms; long source timeouts need segmented scheduling.
const maximumTimerDelayMs = 2147483647;

interface Job {
  readonly id: string;
  readonly digest: string;
  readonly settings: DiscoverySettings;
  readonly abort: AbortController;
  readonly listeners: Set<(snapshot: JobSnapshot) => void>;
  sequence: number;
  progress: DiscoveryEvent | null;
  status: JobTerminal | { state: JobPhase };
  draft: DraftRuntime | null;
  question: QuestionState;
  work: Promise<void>;
}

/** Owns one client's idempotency keys and terminal receipts until closure. */
export class JobRegistry {
  readonly #jobs = new Map<string, Job>();
  readonly #requests = new Map<string, Job>();
  #closing: Promise<void> | null = null;
  constructor(private readonly runner: DiscoveryRunner | null) {}
  /** The discovery settings for a request's selection; discoveryNotConfigured without a runner, else the runner's verdict. */
  settings(selection: DiscoverySelection | undefined): DiscoverySettings {
    if (!this.runner) throw new WorkspaceFailure('discoveryNotConfigured');
    return this.runner.settings(selection);
  }
  /**
   * Starts discovery with `settings` from `settings()`, or returns the job an identical earlier start created. The same
   * identity with a different request or settings fails with requestIdConflict or outputNameConflict and leaves the
   * existing job unchanged.
   */
  start(workspace: WorkspaceHandle, identity: JobIdentity, input: ContextBuildRequest, settings: DiscoverySettings): JobSnapshot {
    if (this.#closing) throw new WorkspaceFailure('clientClosed');
    if ((identity.kind === 'requestId' && !identity.requestId) || !contextRequestValidator.Check(input)) throw new WorkspaceFailure('invalidRequest');
    const request = freeze(structuredClone(input));
    if (!this.runner) throw new WorkspaceFailure('discoveryNotConfigured');
    const discovery = freeze({ ...settings }), admission = jobAdmission(identity, request, discovery), previous = this.#requests.get(admission.key);
    if (previous) {
      if (previous.digest !== admission.digest) {
        admission.log('warn', 'outputNameConflict', null);
        throw new WorkspaceFailure(identity.kind === 'requestId' ? 'requestIdConflict' : 'outputNameConflict');
      }
      admission.log('debug', 'reused', previous.id);
      return this.snapshot(previous.id);
    }
    const job: Job = { id: randomUUID(), digest: admission.digest, settings: discovery, abort: new AbortController(), listeners: new Set(), sequence: 0,
      progress: null, status: { state: 'accepted' }, draft: null, question: { kind: 'idle' }, work: Promise.resolve() };
    this.#jobs.set(job.id, job); this.#requests.set(admission.key, job);
    admission.log('info', 'started', job.id);
    // A request-ID start calls createDraft, which retains the workspace and registers its barrier, before start returns.
    job.work = this.#run(job, workspace, request, this.runner, identity.kind === 'destination' ? admission.key : null);
    return this.snapshot(job.id);
  }
  #get(id: string): Job {
    const job = this.#jobs.get(id);
    if (!job) throw new WorkspaceFailure('unknownJob');
    return job;
  }
  snapshot(id: string): JobSnapshot {
    const job = this.#get(id);
    const facts = { jobId: id, sequence: job.sequence, requestDigest: job.digest, progress: job.progress };
    return isTerminal(job.status) ? freeze({ ...facts, ...job.status, localSettled: true, sharedIndexInterest: 'released' })
      : freeze({ ...facts, ...job.status, localSettled: false, sharedIndexInterest: 'retained' });
  }
  #publish(job: Job, status: Job['status']): void {
    if (isTerminal(job.status)) return;
    job.status = status; job.sequence++;
    const snapshot = this.snapshot(job.id);
    process.stderr.write(JSON.stringify({ level: status.state === 'failed' ? 'error' : status.state === 'blocked' ? 'warn' : 'info',
      event: 'jobState', jobId: job.id, sequence: job.sequence, state: status.state }) + '\n');
    for (const listener of job.listeners) {
      try { listener(snapshot); } catch { /* Progress observers cannot change execution. */ }
    }
  }
  /** `destination` is the key of a destination job, whose output name is checked before draft acquisition; null otherwise. */
  async #run(job: Job, workspace: WorkspaceHandle, request: ContextBuildRequest, runner: DiscoveryRunner,
    destination: string | null): Promise<void> {
    let receipt: DiscoveryReceipt | null = null;
    let terminal: JobTerminal;
    try {
      this.#publish(job, { state: 'reconciling' });
      if (destination !== null) await preflightOutput(job, workspace, request.outputName, destination);
      // As an RPCE MCP run starts in a fresh tab, discovery receives the task as its instructions and writes the prompt itself.
      const draft = await workspace.createDraft(request, job.abort.signal,
        () => this.#publish(job, { state: 'acquiringMaterials' }), '');
      job.draft = draft;
      job.abort.signal.throwIfAborted();
      this.#publish(job, { state: 'discovering' });
      const operation = await draft.operation.fork(job.abort.signal);
      let admitted = true;
      const pending = new Set<Promise<unknown>>();
      try {
        const outcome = await runner.run(await draft.discoveryInput(job.abort.signal), {
          call: (call, signal, encode) => {
            if (!admitted || job.abort.signal.aborted) return Promise.reject(new WorkspaceFailure('cancelled'));
            process.stderr.write(JSON.stringify({ level: 'debug', event: 'discoveryToolCall', jobId: job.id, ...callSummary(call) }) + '\n');
            const combined = AbortSignal.any([signal, job.abort.signal]);
            const cancel = () => operation.cancel();
            combined.addEventListener('abort', cancel, { once: true });
            if (combined.aborted) cancel();
            const work = (call.name === 'ask_user' ? this.#ask(job, request, call.input, operation, combined)
              : scopedCall(call, draft, operation, combined, encode))
              .finally(() => combined.removeEventListener('abort', cancel));
            pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
            return work;
          },
        }, job.abort.signal, event => { job.progress = event; this.#publish(job, job.status); }, job.settings);
        receipt = outcome.receipt;
        if (outcome.kind !== 'complete') throw new WorkspaceFailure(outcome.code);
      } finally {
        admitted = false;
        this.#publish(job, { state: job.abort.signal.aborted ? 'cancelling' : 'settlingDiscovery' });
        await Promise.allSettled([...pending]); await operation.close();
      }
      job.abort.signal.throwIfAborted();
      if (!receipt) throw new WorkspaceFailure('missingDiscoveryReceipt');
      this.#publish(job, { state: 'finalizing' });
      const result = await draft.finalize(job.abort.signal, () => this.#publish(job, { state: 'publishing' }));
      terminal = result.kind === 'ready' ? { state: 'ready', bundle: result, discovery: receipt }
        : { state: 'blocked', validation: result, draftId: draft.id, discovery: receipt };
    } catch (error) {
      terminal = { state: job.abort.signal.aborted ? 'cancelled' : 'failed', code: failureCode(error),
        target: cacheRecoveryTarget(error), discovery: receipt };
    }
    try { await job.draft?.close(); }
    catch { terminal = { state: 'failed', code: 'settlementFailed', target: null, discovery: receipt }; }
    this.#publish(job, terminal);
  }
  inspectDraft(id: string): DraftRuntime {
    for (const job of this.#jobs.values()) if (job.draft?.id === id) return job.draft;
    throw new WorkspaceFailure('unknownDraft');
  }
  pendingQuestion(id: string): PendingQuestion | null {
    const state = this.#get(id).question;
    return state.kind === 'pending' ? freeze(structuredClone(state.question)) : null;
  }
  answerQuestion(id: string, questionId: string, response: ClientQuestionResponse): void {
    const state = this.#get(id).question;
    if (state.kind !== 'pending' || state.question.id !== questionId || !state.respond(freeze(structuredClone(response))))
      throw new WorkspaceFailure('interactionNotCurrent');
  }
  async #ask(job: Job, request: ContextBuildRequest, input: AskUserRequest, operation: WorkspaceOperation, signal: AbortSignal) {
    if (!request.clarification) throw new WorkspaceFailure('clarificationDisabled');
    if (job.question.kind !== 'idle') throw new WorkspaceFailure('askUserAlreadyPending');
    const id = randomUUID(), payload = freeze(structuredClone(input));
    const defaultTimeoutSeconds = request.clarification.questionTimeoutSeconds ?? defaultQuestionTimeoutSeconds;
    job.question = { kind: 'preparing', id };
    try {
      process.stderr.write(JSON.stringify({ level: 'debug', event: 'jobInteraction', jobId: job.id, questionId: id, action: 'preparing' }) + '\n');
      const prepared = await operation.askUser({ kind: 'prepareAskUser', payload, defaultTimeoutSeconds });
      if (prepared.kind === 'askUserInvalid') throw new WorkspaceFailure('invalidQuestion', { message: prepared.message });
      signal.throwIfAborted();
      const started = Date.now();
      const response = await this.#awaitQuestion(job, { id, message: prepared.message,
        requestedSchema: prepared.requestedSchema, fields: prepared.fields },
        prepared.timeoutSeconds, signal);
      signal.throwIfAborted();
      if (response.action === 'cancel') throw new WorkspaceFailure('cancelled');
      const result = await operation.askUser({ kind: 'answerAskUser', payload, defaultTimeoutSeconds,
        action: response.action, content: response.action === 'accept' ? response.content ?? {} : {},
        elapsedSeconds: Math.max(0, Math.floor((Date.now() - started) / 1000)) });
      if (result.kind === 'askUserInvalid') throw new WorkspaceFailure('nativeProtocolError');
      return result.response;
    } finally { job.question = { kind: 'idle' }; }
  }
  #awaitQuestion(job: Job, question: PendingQuestion, timeoutSeconds: number, signal: AbortSignal): Promise<QuestionResponse> {
    return new Promise(resolve => {
      const deadline = performance.now() + timeoutSeconds * 1000;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (response: QuestionResponse) => {
        if (job.question.kind !== 'pending' || job.question.question.id !== question.id) return;
        job.question = { kind: 'answering', id: question.id };
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        this.#questionProgress(job, question.id, response.action);
        resolve(response);
      };
      const expire = () => {
        const remaining = deadline - performance.now();
        if (remaining > 0) timer = setTimeout(expire, Math.min(remaining, maximumTimerDelayMs));
        else finish({ action: 'timeout' });
      };
      const abort = () => finish({ action: 'cancel' });
      timer = setTimeout(expire, Math.min(timeoutSeconds * 1000, maximumTimerDelayMs));
      job.question = { kind: 'pending', question: freeze(structuredClone(question)), respond: response => {
        const expired = performance.now() >= deadline;
        finish(expired ? { action: 'timeout' } : response);
        return !expired;
      } };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else this.#questionProgress(job, question.id, 'pending');
    });
  }
  #questionProgress(job: Job, questionId: string, action: QuestionResponse['action'] | 'pending'): void {
    process.stderr.write(JSON.stringify({ level: 'info', event: 'jobInteraction', jobId: job.id, questionId, action }) + '\n');
    job.progress = { kind: action === 'pending' ? 'awaitingUser' : 'userInteractionSettled', attempt: null, delayMs: null,
      success: action === 'pending' ? null : action === 'accept', reason: action === 'pending' ? null : action };
    this.#publish(job, job.status);
  }
  cancel(id: string) {
    const job = this.#get(id);
    if (isTerminal(job.status)) return this.snapshot(id);
    const publication = job.draft?.cancelFinalization();
    if (publication?.kind === 'publicationInProgress') return { kind: 'publicationInProgress' as const, jobId: id };
    job.abort.abort(); this.#publish(job, { state: 'cancelling' });
    return this.snapshot(id);
  }
  async dispose(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const job = this.#get(id);
    this.cancel(id);
    await job.work;
    signal.throwIfAborted();
    let deletedSnapshots = 0;
    if (job.draft) {
      deletedSnapshots = (await job.draft.dispose(signal)).deletedSnapshots;
      job.draft = null;
    }
    return { kind: 'disposed' as const, jobId: id, deletedSnapshots };
  }
  async wait(id: string, durationMs: number, signal: AbortSignal, progress: (snapshot: JobSnapshot) => void): Promise<JobSnapshot> {
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 2147483647) throw new WorkspaceFailure('invalidWaitDuration');
    signal.throwIfAborted();
    const job = this.#get(id);
    if (isTerminal(job.status) || job.question.kind === 'pending' || durationMs === 0) return this.snapshot(id);
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); job.listeners.delete(listener); };
      const abort = () => { finish(); reject(new WorkspaceFailure('cancelled')); };
      const listener = (snapshot: JobSnapshot) => { progress(snapshot);
        if (snapshot.localSettled || job.question.kind === 'pending') { finish(); resolve(snapshot); } };
      const timer = setTimeout(() => { finish(); resolve(this.snapshot(id)); }, durationMs);
      job.listeners.add(listener); signal.addEventListener('abort', abort, { once: true });
      void job.work.then(() => { finish(); resolve(this.snapshot(id)); });
    });
  }
  close(): Promise<void> {
    this.#closing ??= (async () => {
      for (const job of this.#jobs.values()) this.cancel(job.id);
      await Promise.all([...this.#jobs.values()].map(job => job.work));
    })();
    return this.#closing;
  }
}
function isTerminal(status: Job['status']): status is JobTerminal { return ['ready', 'blocked', 'failed', 'cancelled'].includes(status.state); }

/**
 * The retry key and request digest for a start. Request-ID keys and destination keys occupy separate namespaces; a
 * destination key names the output directory by physical identity, and its digest covers the workspace's authority.
 * Both digests cover the discovery settings, so a start with another model or level is not a retry.
 */
function jobAdmission(identity: JobIdentity, request: ContextBuildRequest, discovery: DiscoverySettings) {
  if (identity.kind === 'requestId') return { key: canonicalJSON(['requestId', identity.requestId]),
    digest: sha256(canonicalJSON({ workspaceId: identity.workspaceId, request, discovery })), log: () => {} };
  const { canonicalPath, device, inode } = identity.outputRoot;
  const key = canonicalJSON(['destination', canonicalPath, device, inode, request.outputName]);
  return { key, digest: sha256(canonicalJSON({ workspaceKey: identity.workspaceKey, request, discovery })),
    log: (level: string, outcome: string, jobId: string | null) => process.stderr.write(JSON.stringify({ level,
      event: 'jobAdmission', outcome, destination: sha256(key), jobId }) + '\n') };
}

/** Fails a destination job before draft acquisition when its output name is already occupied. */
async function preflightOutput(job: Job, workspace: WorkspaceHandle, outputName: string, destination: string): Promise<void> {
  try { await workspace.assertOutputAvailable(outputName, job.abort.signal); }
  catch (error) {
    const code = failureCode(error);
    if (code !== 'cancelled') process.stderr.write(JSON.stringify({ level: code === 'alreadyExists' ? 'warn' : 'error',
      event: 'jobOutputPreflight', jobId: job.id, destination: sha256(destination), code }) + '\n');
    throw error;
  }
}
