import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ProcessSupervisor } from '../runtime/process-supervisor.js';
import { failureResult, piToolResult } from '../runtime/tool-result.js';
import { freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
import type { DiscoveryReceipt, DiscoveryEvent } from '../contracts/discovery.js';
import type { DiscoveryInput, DiscoveryOutcome, DiscoveryRunner, DiscoveryTools } from './runner.js';
import { piConfigValidator, workerValidator, type PiConfig, type WorkerMessage } from './pi-protocol.js';
import { receive, send } from './pi-channel.js';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SHA256 } from '../contracts/workspace.js';
import { completeDiscovery } from './completion.js';
import { readRegularFile } from '../runtime/host-files.js';

const dependencyValidator = Compile(Type.Object({ buildLockSHA256: SHA256 }, { additionalProperties: false }));

export class PiRunner implements DiscoveryRunner {
  readonly config: PiConfig;
  constructor(config: PiConfig, private readonly supervisor: ProcessSupervisor) {
    if (!piConfigValidator.Check(config)) throw new WorkspaceFailure('invalidDiscoveryConfiguration');
    if (Object.keys(config.environment).some(name => name === 'NODE_OPTIONS' || name.startsWith('PI_'))) {
      throw new WorkspaceFailure('unsafeWorkerEnvironment');
    }
    this.config = freeze(structuredClone(config));
  }
  async run(input: DiscoveryInput, tools: DiscoveryTools, signal: AbortSignal,
    progress: (event: DiscoveryEvent) => void): Promise<DiscoveryOutcome> {
    signal.throwIfAborted();
    const prompt = await readRegularFile(this.config.promptPath, new WorkspaceFailure('nonRegularDiscoveryPrompt'), signal);
    let promptText: string;
    try { promptText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(prompt); }
    catch { throw new WorkspaceFailure('invalidDiscoveryPrompt'); }
    if (!promptText.startsWith('# smip discovery v1\n')) throw new WorkspaceFailure('invalidDiscoveryPrompt');
    const dependency: unknown = JSON.parse(await readFile(new URL('../dependency-identity.json', import.meta.url), 'utf8'));
    if (!dependencyValidator.Check(dependency)) throw new WorkspaceFailure('invalidDependencyIdentity');
    const receipt: DiscoveryReceipt = {
      adapter: 'smip-pi-v1', sdk: '1.0.2', buildLockSHA256: dependency.buildLockSHA256,
      promptVersion: 'discovery-v1', promptSHA256: sha256(prompt),
      requested: { provider: this.config.provider, model: this.config.model, thinking: this.config.thinking },
      effective: null, policy: structuredClone(this.config.policy), completions: [], events: [], prompt: 'notStarted',
      finalAssistant: null,
      acceptedRuns: 0, settled: false, idle: false, observationsSettled: false, disposed: false,
      workerClosed: false, parentToolsSettled: false,
      telemetryLimit: 'Local dispatch and SDK completion metadata only. Provider-internal attempts may be unobserved; Codex server model identity is unavailable. Local closure does not prove remote cancellation or billing cessation.',
    };
    signal.throwIfAborted();
    const scope = { generation: randomUUID(), job: randomUUID() };
    const child = this.supervisor.spawn({ executable: process.execPath,
      args: [fileURLToPath(new URL('./pi-worker.js', import.meta.url))], cwd: '/',
      env: { ...this.config.environment, PI_OFFLINE: '1' } });
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
    if (signal.aborted) abort();
    else send(child.child.stdin, { ...scope, kind: 'start', config: this.config, input, prompt: promptText });
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
