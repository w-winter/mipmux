import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ProcessSupervisor } from '../runtime/process-supervisor.js';
import { failureResult, piToolResult } from '../runtime/tool-result.js';
import { freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
import type { DiscoveryReceipt, DiscoveryEvent } from '../contracts/discovery.js';
import type { DiscoveryInput, DiscoveryOutcome, DiscoveryRunner, DiscoveryTools } from './runner.js';
import { piConfigValidator, workerValidator, type PiConfig, type WorkerMessage, type DiscoverySessionInput } from './pi-protocol.js';
import { receive, send } from './pi-channel.js';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SHA256 } from '../contracts/workspace.js';
import { completeDiscovery } from './completion.js';
import { readRegularFile } from '../runtime/host-files.js';
import { admitMcpConfiguration, type AdmittedMcp } from './mcp-config.js';
import { prepareDiscoveryInput, type DiscoveryPromptRenderer } from '../context/discovery-input.js';
import type { SourceIdentity } from '../contracts/workspace.js';

const dependencyValidator = Compile(Type.Object({ buildLockSHA256: SHA256 }, { additionalProperties: false }));
const systemFileFailure = Compile(Type.Object({ code: Type.String() }));

async function readDiscoveryTemplate(path: string, signal: AbortSignal) {
  let bytes: Buffer;
  try { bytes = await readRegularFile(path, new WorkspaceFailure('nonRegularDiscoveryTemplate'), signal); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof WorkspaceFailure) throw error;
    if (systemFileFailure.Check(error)) {
      throw new WorkspaceFailure('discoveryTemplateReadFailed', { systemCode: error.code });
    }
    throw error;
  }
  try { return { bytes, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; }
  catch (cause) {
    const failure = new WorkspaceFailure('invalidDiscoveryTemplate', { kind: 'encoding' });
    failure.cause = cause;
    throw failure;
  }
}

function logTemplateRejection(error: WorkspaceFailure, path: string, identity: SourceIdentity | null) {
  const record = { level: 'error', event: 'discoveryTemplateRejected', code: error.code,
    templatePath: path, ...error.details };
  if (identity) Object.assign(record, { templateSHA256: identity.sha256 });
  process.stderr.write(JSON.stringify(record) + '\n');
}

export class PiRunner implements DiscoveryRunner {
  readonly config: PiConfig;
  constructor(config: PiConfig, private readonly supervisor: ProcessSupervisor, private readonly renderPrompt: DiscoveryPromptRenderer) {
    if (!piConfigValidator.Check(config)) throw new WorkspaceFailure('invalidDiscoveryConfiguration');
    if (Object.keys(config.environment).some(name => name === 'NODE_OPTIONS' || name.startsWith('PI_'))) {
      throw new WorkspaceFailure('unsafeWorkerEnvironment');
    }
    this.config = freeze(structuredClone(config));
  }
  async run(input: DiscoveryInput, tools: DiscoveryTools, signal: AbortSignal,
    progress: (event: DiscoveryEvent) => void): Promise<DiscoveryOutcome> {
    signal.throwIfAborted();
    let admitted: Awaited<ReturnType<typeof readDiscoveryTemplate>>;
    try { admitted = await readDiscoveryTemplate(this.config.promptTemplatePath, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof WorkspaceFailure) logTemplateRejection(error, this.config.promptTemplatePath, null);
      throw error;
    }
    const templateIdentity = { sha256: sha256(admitted.bytes), byteCount: admitted.bytes.length };
    let prepared: Awaited<ReturnType<typeof prepareDiscoveryInput>>;
    try { prepared = await prepareDiscoveryInput(input, admitted.text, signal, this.renderPrompt); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof WorkspaceFailure) logTemplateRejection(error, this.config.promptTemplatePath, templateIdentity);
      throw error;
    }
    signal.throwIfAborted();
    let mcp: AdmittedMcp | null;
    try { mcp = this.config.mcp ? await admitMcpConfiguration(this.config.mcp, signal) : null; }
    catch (error) {
      if (error instanceof WorkspaceFailure) process.stderr.write(JSON.stringify({ level: 'error', event: 'mcpConfigurationRejected',
        code: error.code, ...error.details }) + '\n');
      throw error;
    }
    const dependency: unknown = JSON.parse(await readFile(new URL('../dependency-identity.json', import.meta.url), 'utf8'));
    if (!dependencyValidator.Check(dependency)) throw new WorkspaceFailure('invalidDependencyIdentity');
    const receipt: DiscoveryReceipt = {
      adapter: 'smip-pi-v2', sdk: '1.0.2', buildLockSHA256: dependency.buildLockSHA256,
      templateVersion: 'smip-discovery-template-v1',
      template: { path: this.config.promptTemplatePath, identity: templateIdentity },
      policyIdentity: { sha256: sha256(prepared.systemPrompt), byteCount: Buffer.byteLength(prepared.systemPrompt) },
      requested: { provider: this.config.provider, model: this.config.model, thinking: this.config.thinking },
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
    else send(child.child.stdin, { ...scope, kind: 'start', config: this.config,
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
