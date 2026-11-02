import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ProcessSupervisor } from '../runtime/process-supervisor.js';
import { failureResult, piToolResult } from '../runtime/tool-result.js';
import { freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
import type { PiDiscoveryReceipt, DiscoveryEvent, DiscoverySelection } from '../contracts/discovery.js';
import type { DiscoveryInput, DiscoveryOutcome, DiscoveryRunner, DiscoveryTools } from './runner.js';
import { modelsReplyValidator, piConfigValidator, workerValidator, type ModelsReply, type PiConfig, type WorkerMessage,
  type DiscoverySessionInput } from './pi-protocol.js';
import { checkedDefaults, selectDiscovery, type DiscoveryDefaults, type DiscoveryHostConfig, type DiscoverySettings } from './selection.js';
import { receive, send } from './pi-channel.js';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SHA256 } from '../contracts/workspace.js';
import { completeDiscovery } from './completion.js';
import type { DiscoveryPromptRenderer } from '../context/discovery-input.js';
import { admitRunMcp, prepareDiscoveryRun } from './template-file.js';

const dependencyValidator = Compile(Type.Object({ buildLockSHA256: SHA256 }, { additionalProperties: false }));
/** What the parent observed of a models worker: its replies, and whether it broke the protocol. */
interface ModelsListing { readonly replies: ModelsReply[]; protocolFailed: boolean }

export class PiRunner implements DiscoveryRunner {
  /** The worker configuration as started; each run replaces its model and level with the run's settings. */
  readonly config: PiConfig;
  readonly #defaults: DiscoveryDefaults;
  constructor(config: DiscoveryHostConfig, private readonly supervisor: ProcessSupervisor, private readonly renderPrompt: DiscoveryPromptRenderer) {
    const { allowedModels, ...worker } = config;
    if (!piConfigValidator.Check(worker)) throw new WorkspaceFailure('invalidDiscoveryConfiguration');
    if (Object.keys(worker.environment).some(name => name === 'NODE_OPTIONS' || name.startsWith('PI_'))) {
      throw new WorkspaceFailure('unsafeWorkerEnvironment');
    }
    this.config = freeze(structuredClone(worker));
    this.#defaults = checkedDefaults({ provider: worker.provider, model: worker.model, thinking: worker.thinking, allowedModels });
  }
  /** The `provider/model` references discovery has credentials for, listed by a worker with discovery's environment. */
  async listModels(signal: AbortSignal): Promise<string[]> {
    const child = this.supervisor.spawn({ executable: process.execPath,
      args: [fileURLToPath(new URL('./models-worker.js', import.meta.url))], cwd: '/', env: { ...this.config.environment, PI_OFFLINE: '1' } });
    const stop = () => { void child.stop(); };
    signal.addEventListener('abort', stop, { once: true });
    const state: ModelsListing = { replies: [], protocolFailed: false };
    const retire = () => { state.protocolFailed = true; stop(); };
    receive(child.child.stdout, value => {
      if (modelsReplyValidator.Check(value) && !state.replies.length) state.replies.push(value);
      else retire();
    }, retire);
    send(child.child.stdin, { kind: 'listModels', config: this.config });
    const closed = await child.closed;
    signal.removeEventListener('abort', stop);
    signal.throwIfAborted();
    const [reply] = state.replies;
    if (state.protocolFailed || closed.code !== 0 || closed.signal || closed.spawnError || !reply) throw new WorkspaceFailure('discoveryWorkerFailed');
    if (reply.kind === 'failed') throw new WorkspaceFailure(reply.code);
    return reply.models;
  }
  settings(selection: DiscoverySelection | undefined): DiscoverySettings {
    return selectDiscovery(this.#defaults, selection);
  }
  async run(input: DiscoveryInput, tools: DiscoveryTools, signal: AbortSignal,
    progress: (event: DiscoveryEvent) => void, settings: DiscoverySettings): Promise<DiscoveryOutcome<PiDiscoveryReceipt>> {
    signal.throwIfAborted();
    const config = freeze({ ...this.config, provider: settings.provider, model: settings.model, thinking: settings.thinking });
    const { templateIdentity, prepared } = await prepareDiscoveryRun(this.config.promptTemplatePath, input, this.config.codemode, '',
      signal, this.renderPrompt);
    signal.throwIfAborted();
    const mcp = await admitRunMcp(this.config.mcp, signal);
    const dependency: unknown = JSON.parse(await readFile(new URL('../dependency-identity.json', import.meta.url), 'utf8'));
    if (!dependencyValidator.Check(dependency)) throw new WorkspaceFailure('invalidDependencyIdentity');
    const receipt: PiDiscoveryReceipt = {
      adapter: 'mipmux-pi-v2', sdk: '1.5.0', buildLockSHA256: dependency.buildLockSHA256,
      templateVersion: 'mipmux-discovery-template-v1',
      template: { path: this.config.promptTemplatePath, identity: templateIdentity },
      policyIdentity: { sha256: sha256(prepared.systemPrompt), byteCount: Buffer.byteLength(prepared.systemPrompt) },
      requested: { provider: config.provider, model: config.model, thinking: config.thinking }, thinkingLevels: null,
      effective: null, policy: structuredClone(this.config.policy), completions: [], events: [], prompt: 'notStarted',
      finalAssistant: null,
      acceptedRuns: 0, settled: false, idle: false, observationsSettled: false, disposed: false,
      workerClosed: false, parentToolsSettled: false,
      mcp: mcp ? { configSHA256: mcp.configSHA256, servers: Object.entries(mcp.configuration.mcpServers).map(([name, server]) => ({
        name, endpointSHA256: sha256(server.url), tools: Object.keys(server.toolExposure).sort(),
      })), readiness: { state: 'notObserved' }, shutdown: 'notObserved' } : null,
      telemetryLimit: 'Local dispatch and SDK completion metadata only. Provider-internal attempts may be unobserved; Codex server model identity is unavailable. Local closure does not prove remote cancellation or billing cessation.',
    };
    signal.throwIfAborted();
    const scope = { generation: randomUUID(), job: randomUUID() };
    const environment = { ...this.config.environment, PI_OFFLINE: '1' };
    if (mcp) Object.assign(environment, {
      HOME: mcp.reference.agentDirectory, TMPDIR: mcp.reference.agentDirectory, PI_CODING_AGENT_DIR: mcp.reference.agentDirectory,
    });
    const child = this.supervisor.spawn({ executable: process.execPath,
      args: [fileURLToPath(new URL('./pi-worker.js', import.meta.url))], cwd: '/',
      env: environment });
    const calls = new Set<string>(), pending = new Set<Promise<void>>();
    const cancel = new AbortController();
    const combined = AbortSignal.any([signal, cancel.signal]);
    const state: { terminal: Extract<WorkerMessage, { kind: 'complete' }> | null } = { terminal: null };
    let protocolFailed = false, admission = true;
    const retire = () => { protocolFailed = true; admission = false; cancel.abort(); void child.stop(); };
    const abort = () => {
      admission = false;
      send(child.child.stdin, { ...scope, kind: 'abort' });
      void child.stop();
    };
    child.child.stdin.on('error', retire);
    receive(child.child.stdout, value => {
      if (!admission || !workerValidator.Check(value) || value.job !== scope.job || value.generation !== scope.generation || state.terminal) {
        retire(); return;
      }
      if (value.kind === 'evidence') {
        const fact = value.fact;
        if (fact.kind === 'preflight') { receipt.effective = fact.effective; receipt.policy = fact.policy; }
        else if (fact.kind === 'modelCapabilities') receipt.thinkingLevels = fact.thinkingLevels;
        else if (fact.kind === 'completion') receipt.completions.push(fact.value);
        else if (fact.kind === 'assistant') receipt.finalAssistant = fact.value;
        else if (fact.kind === 'prompt') receipt.prompt = fact.outcome;
        else if (fact.kind === 'mcpReadiness' || fact.kind === 'mcpShutdown') {
          if (!receipt.mcp) { retire(); return; }
          if (fact.kind === 'mcpReadiness') receipt.mcp.readiness = fact.value;
          else receipt.mcp.shutdown = fact.outcome;
        }
        else if (fact.stage === 'accepted') receipt.acceptedRuns++;
        else receipt[fact.stage] = true;
        return;
      }
      if (value.kind === 'progress') {
        receipt.events.push(value.event);
        try { progress(value.event); } catch { /* Progress observers cannot change execution. */ }
        return;
      }
      if (value.kind === 'complete') {
        if (pending.size) { retire(); return; }
        state.terminal = value; admission = false; return;
      }
      if (!admission || calls.has(value.id)) { retire(); return; }
      calls.add(value.id);
      const work = (async () => {
        let result: unknown, failed = false;
        try { combined.throwIfAborted(); result = await tools.call(value.call, combined, piToolResult); }
        catch (error) { result = failureResult(error); failed = true; }
        if (admission) send(child.child.stdin, { ...scope, kind: 'toolResult', id: value.id, value: result, failed });
      })();
      pending.add(work);
      void work.then(() => pending.delete(work), retire);
    }, retire);
    signal.addEventListener('abort', abort, { once: true });
    const sessionInput: DiscoverySessionInput = { message: prepared.message, initialContext: input.initialContext };
    if (input.clarification) sessionInput.clarification = input.clarification;
    if (signal.aborted) abort();
    else send(child.child.stdin, { ...scope, kind: 'start', config,
      input: sessionInput, prompt: prepared.systemPrompt, mcp });
    const closed = await child.closed;
    admission = false; cancel.abort();
    await Promise.allSettled([...pending]);
    signal.removeEventListener('abort', abort);
    // Read the terminal only after close so trailing or duplicate records cannot report success.
    const result = state.terminal;
    receipt.workerClosed = true; receipt.parentToolsSettled = true;
    if (signal.aborted) return { kind: 'cancelled', code: 'cancelled', receipt: freeze(receipt) };
    if (protocolFailed || closed.code !== 0 || closed.signal || closed.spawnError || !result) {
      return { kind: 'failed', code: protocolFailed ? 'workerProtocolError' : 'discoveryWorkerFailed', receipt: freeze(receipt) };
    }
    if (result.outcome === 'complete' && !completeDiscovery(receipt)) {
      return { kind: 'failed', code: 'incompleteDiscoveryReceipt', receipt: freeze(receipt) };
    }
    return result.outcome === 'complete' ? { kind: 'complete', receipt: freeze(receipt) }
      : { kind: result.outcome, code: result.code, receipt: freeze(receipt) };
  }
}
