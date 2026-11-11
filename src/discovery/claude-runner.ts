import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { McpServer } from '@modelcontextprotocol/server';
import type { McpSdkServerConfigWithInstance, ModelInfo, Options, Query, SDKAssistantMessage, SDKMessage, SDKResultMessage,
  SDKUserMessage, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { callValidator, toolSchemas, type ClaudeCodeDiscoveryReceipt, type Completion, type DiscoveryEvent,
  type ThinkingLevel, type TokenUsage } from '../contracts/discovery.js';
import { toolDescription } from '../contracts/exploration.js';
import type { DiscoveryPromptRenderer } from '../context/discovery-input.js';
import type { OwnedProcess, ProcessSupervisor } from '../runtime/process-supervisor.js';
import { failureCode, failureResult, piToolResult } from '../runtime/tool-result.js';
import { canonicalJSON, freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
import type { ExternalTools, ServedTool } from './claude-tools.js';
import { completeClaudeCodeDiscovery } from './completion.js';
import { claudeCodeProvider, mipmuxToolPrefix, type ClaudeCodeConfig } from './discovery-config.js';
import { advertisedSchema } from './advertised-schema.js';
import type { AdmittedMcp, McpReference } from './mcp-config.js';
import type { DiscoveryInput, DiscoveryOutcome, DiscoveryTools } from './runner.js';
import type { DiscoverySettings } from './selection.js';
import { admitRunMcp, prepareDiscoveryRun } from './template-file.js';

/** The Claude Agent SDK version this runner is tested with; another installed version fails with claudeAgentSdkVersionMismatch. */
export const claudeAgentSdkVersion = '0.3.310';
const installHint = `Install it next to mipmux with npm install -g @anthropic-ai/claude-agent-sdk@${claudeAgentSdkVersion}, ` +
  'or without -g into the project that installs mipmux.';
const claudeAgentSdkApi = 'claude-agent-sdk';
/** The model Claude Code names in assistant messages it writes itself, such as an API error report, rather than receives. */
const syntheticModel = '<synthetic>';
/** Claude Code's largest timer delay; a tool call, such as an `ask_user` waiting for its answer, is never cut short. */
const maximumToolCallMs = 2_147_483_647;
const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = typeof effortLevels[number];
/**
 * Set in every Claude Code child: no claude.ai connectors, which strict MCP configuration does not exclude; no moving a
 * long tool call to the background, which would end the turn without its result; no telemetry or update traffic; no
 * tool search, whose placeholder tool newer models would otherwise receive although mipmux defers no tool; and mipmux
 * as the client Claude Code reports to Anthropic, in place of the SDK's default `sdk-ts`.
 */
const childSettings = { ENABLE_CLAUDEAI_MCP_SERVERS: '0', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_ENTRYPOINT: 'mipmux' };
const telemetryLimit = 'Claude Code reports each response, its usage and a list-price cost. Requests Claude Code makes for its own ' +
  'purposes may be unobserved. Local closure does not prove remote cancellation or billing cessation.';
const moduleNotFound = Compile(Type.Object({ code: Type.Literal('ERR_MODULE_NOT_FOUND') }));
const sdkPackage = Compile(Type.Object({ version: Type.String() }));
type ClaudeAgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');
type ClaudeTools = typeof import('./claude-tools.js');
type ContentBlock = SDKAssistantMessage['message']['content'][number];

/**
 * Loads the Claude Agent SDK, an optional add-on only Claude Code discovery needs, and checks its version. A dynamic
 * import keeps hosts that never run Claude Code discovery from loading it.
 */
async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdk> {
  let sdk: ClaudeAgentSdk;
  try { sdk = await import('@anthropic-ai/claude-agent-sdk'); }
  catch (error) {
    if (!moduleNotFound.Check(error)) throw error;
    throw Object.defineProperty(new WorkspaceFailure('claudeAgentSdkUnavailable',
      { message: `Claude Code discovery needs the Claude Agent SDK, which is not installed. ${installHint}` }), 'cause', { value: error });
  }
  const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  const { version } = sdkPackage.Parse(JSON.parse(await readFile(join(dirname(entry), 'package.json'), 'utf8')));
  if (version !== claudeAgentSdkVersion) {
    throw new WorkspaceFailure('claudeAgentSdkVersionMismatch',
      { message: `Claude Code discovery needs Claude Agent SDK ${claudeAgentSdkVersion}, and ${version} is installed. ${installHint}` });
  }
  return sdk;
}

/** The model a `claude-code/` reference names for a Claude Code model entry: its value when that is a model name, otherwise the model its alias stands for. */
function modelName(info: ModelInfo): string {
  return info.value.startsWith('claude-') ? info.value : info.resolvedModel ?? info.value;
}

function isEffortLevel(level: ThinkingLevel): level is EffortLevel {
  return effortLevels.some(effort => effort === level);
}

/** `off` asks Claude Code to disable thinking; any other level must be one of the model's effort levels. */
function supportsLevel(level: ThinkingLevel, effort: readonly string[]): boolean {
  return level === 'off' || (isEffortLevel(level) && effort.includes(level));
}

function definedEnvironment(environment: SpawnOptions['env']): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).flatMap(([name, value]) => value === undefined ? [] : [[name, value]]));
}

/** One Claude Code process driven through the SDK. Its single prompt waits until `release`; `end` closes the input, so it exits. */
class ClaudeCodeProcess {
  readonly children: OwnedProcess[] = [];
  readonly query: Query;
  readonly #supervisor: ProcessSupervisor;
  readonly #workingDirectory: string;
  #release: (message: SDKUserMessage | null) => void = () => {};
  #finish: () => void = () => {};
  constructor(sdk: ClaudeAgentSdk, options: Options, supervisor: ProcessSupervisor, workingDirectory: string) {
    this.#supervisor = supervisor;
    this.#workingDirectory = workingDirectory;
    const released = new Promise<SDKUserMessage | null>(resolve => { this.#release = resolve; });
    const finished = new Promise<void>(resolve => { this.#finish = resolve; });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      const message = await released;
      if (!message) return;
      yield message;
      await finished;
    }
    this.query = sdk.query({ prompt: input(), options: { ...options, spawnClaudeCodeProcess: spawn => this.#spawn(spawn) } });
  }
  release(text: string): void { this.#release({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }); }
  end(): void { this.#release(null); this.#finish(); }
  /** Whether Claude Code started and every process it ran has closed, once they have. */
  async closed(): Promise<boolean> {
    await Promise.all(this.children.map(child => child.closed));
    return this.children.length > 0;
  }
  #spawn(spawn: SpawnOptions) {
    const owned = this.#supervisor.spawn({ executable: spawn.command, args: spawn.args, cwd: spawn.cwd ?? this.#workingDirectory,
      env: definedEnvironment(spawn.env) });
    this.children.push(owned);
    spawn.signal.addEventListener('abort', () => { void owned.stop(); }, { once: true });
    return owned.child;
  }
}

/** One model response, assembled from the assistant messages Claude Code reports under its ID. */
interface Response { model: string; stopReason: string | null; readonly blocks: ContentBlock[]; usage: TokenUsage }

function stopReason(reason: string | null): Completion['stopReason'] {
  switch (reason) {
    case null: return 'pending';
    case 'end_turn': case 'stop_sequence': return 'stop';
    case 'tool_use': return 'toolUse';
    case 'max_tokens': case 'model_context_window_exceeded': return 'length';
    default: return 'error';
  }
}

/**
 * Claude Code reports each content block as it finishes, before the response's stop reason arrives. A response that
 * called tools stopped to use them, and the closing result reports the last response's reason.
 */
function completions(responses: readonly Response[], finalStop: string | null, requestedModel: string): Completion[] {
  return responses.map((response, index) => completion({ ...response, stopReason: response.stopReason ?? (index === responses.length - 1
    ? finalStop : response.blocks.some(block => block.type === 'tool_use') ? 'tool_use' : null) }, requestedModel));
}

function completion(response: Response, requestedModel: string): Completion {
  const text = response.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  // Names as the model called them, so a call to a name Claude Code does not offer stays distinguishable.
  const toolCalls = response.blocks.flatMap(block => block.type === 'tool_use' ? [block.name] : []);
  return { dispatched: { provider: claudeCodeProvider, model: requestedModel, api: claudeAgentSdkApi },
    reported: { provider: claudeCodeProvider, model: response.model, api: claudeAgentSdkApi }, serverModel: response.model, reportedServerModels: null,
    stopReason: stopReason(response.stopReason), channel: 'ordinary', textBytes: Buffer.byteLength(text), textSHA256: sha256(text),
    textOnly: response.blocks.every(block => block.type === 'text' || block.type === 'thinking' || block.type === 'redacted_thinking'),
    nonempty: text.trim().length > 0, diagnostics: [], usage: response.usage, toolCalls };
}

/** What one discovery run serves Claude Code and expects it to report. */
interface RunPlan {
  readonly settings: DiscoverySettings;
  readonly options: Options;
  readonly message: string;
  /** Per in-process server, the tool names it serves. */
  readonly servers: ReadonlyMap<string, readonly string[]>;
  readonly receipt: ClaudeCodeDiscoveryReceipt;
  readonly signal: AbortSignal;
  readonly progress: (event: DiscoveryEvent) => void;
}

/** One discovery conversation with Claude Code: checks before the prompt, then observation until Claude Code exits. */
class ClaudeCodeRun {
  readonly #plan: RunPlan;
  readonly #process: ClaudeCodeProcess;
  readonly #responses = new Map<string, Response>();
  #failure: string | null = null;
  #servedModel: string | null = null;
  #finalStop: string | null = null;
  constructor(plan: RunPlan, process: ClaudeCodeProcess) { this.#plan = plan; this.#process = process; }

  /** Runs the conversation and returns its failure code, or null; the receipt is complete when it returns. */
  async execute(): Promise<string | null> {
    const { signal, receipt } = this.#plan;
    const cancel = () => { this.#stop('cancelled'); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const refused = await this.#preflight();
      if (refused) this.#stop(refused);
      else if (!signal.aborted) { this.#process.release(this.#plan.message); receipt.prompt = 'resolved'; }
      for await (const message of this.#process.query) this.#observe(message);
    } catch (error) {
      this.#failure ??= signal.aborted ? 'cancelled' : failureCode(error) === 'operationFailed' ? 'claudeCodeFailed' : failureCode(error);
    } finally {
      signal.removeEventListener('abort', cancel);
      this.#process.end();
      receipt.childClosed = await this.#process.closed();
      receipt.completions.push(...completions([...this.#responses.values()], this.#finalStop, this.#plan.settings.model));
      receipt.finalAssistant = receipt.completions.at(-1) ?? null;
    }
    return this.#failure;
  }

  /**
   * Checks, before any model request, that the model supports the level and that Claude Code offers exactly the served
   * tools. Claude Code lists the model it was started with, with the effort levels it knows for it, even a model its
   * picker does not offer; Anthropic's API refuses a model that does not exist.
   */
  async #preflight(): Promise<string | null> {
    const { settings, receipt, servers } = this.#plan;
    const info = (await this.#process.query.supportedModels()).find(model => modelName(model) === settings.model);
    if (!info) return 'modelUnavailable';
    this.#servedModel = info.resolvedModel ?? settings.model;
    receipt.thinkingLevels = [...info.supportedEffortLevels ?? []];
    if (!supportsLevel(settings.thinking, receipt.thinkingLevels)) return 'unsupportedThinkingLevel';
    const statuses = await this.#process.query.mcpServerStatus();
    if (statuses.length !== servers.size) return 'unexpectedToolAccess';
    for (const status of statuses) {
      const expected = servers.get(status.name);
      if (!expected) return 'unexpectedToolAccess';
      const offered = (status.tools ?? []).map(tool => tool.name).sort();
      if (status.status !== 'connected' || canonicalJSON(offered) !== canonicalJSON([...expected].sort())) return 'mcpToolsUnavailable';
    }
    return null;
  }

  #stop(code: string): void {
    this.#failure ??= code;
    void this.#process.query.interrupt().catch(() => undefined).finally(() => { this.#process.end(); });
  }

  #observe(message: SDKMessage): void {
    if (message.type === 'assistant') this.#assistant(message);
    else if (message.type === 'result') this.#result(message);
    else if (message.type === 'system') {
      if (message.subtype === 'init') this.#initialized(message.claude_code_version, message.model, message.apiKeySource, message.tools);
      else if (message.subtype === 'api_retry') {
        this.#event({ kind: 'api_retry', attempt: message.attempt, delayMs: Math.round(message.retry_delay_ms), success: null,
          reason: message.error_status === null ? null : String(message.error_status) });
      } else if (message.subtype === 'compact_boundary') {
        this.#event({ kind: 'compact_boundary', attempt: null, delayMs: null, success: true, reason: message.compact_metadata.trigger });
      }
    }
  }

  #initialized(version: string, model: string, apiKeySource: string, tools: readonly string[]): void {
    const { receipt, servers, settings } = this.#plan;
    receipt.claudeCodeVersion = version;
    receipt.effective = { model, servedModel: this.#servedModel ?? model, apiKeySource, tools: [...tools].sort() };
    const expected = [...servers].flatMap(([server, names]) => names.map(name => `mcp__${server}__${name}`)).sort();
    if (canonicalJSON(receipt.effective.tools) !== canonicalJSON(expected)) this.#stop('unexpectedToolAccess');
    else if (model !== settings.model) this.#stop('modelSelectionChanged');
  }

  #assistant(message: SDKAssistantMessage): void {
    if (message.parent_tool_use_id !== null) return;
    const { id, model, stop_reason: reason, content, usage } = message.message;
    const response = this.#responses.get(id) ?? { model, stopReason: reason, blocks: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    response.model = model;
    response.stopReason = reason;
    response.blocks.push(...content);
    response.usage = { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0 };
    this.#responses.set(id, response);
    if (model !== syntheticModel && model !== this.#servedModel) this.#stop('modelIdentityMismatch');
  }

  #result(message: SDKResultMessage): void {
    const errors = message.subtype === 'success' ? (message.is_error ? [message.result] : []) : [...message.errors];
    this.#plan.receipt.result = { subtype: message.subtype, turns: message.num_turns, durationMs: Math.round(message.duration_ms),
      costUsd: message.total_cost_usd, usage: { input: message.usage.input_tokens, output: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens, cacheWrite: message.usage.cache_creation_input_tokens }, errors };
    if (message.subtype !== 'success' || message.is_error) this.#failure ??= 'claudeCodeFailed';
    this.#finalStop = message.stop_reason;
    this.#process.end();
  }

  #event(event: DiscoveryEvent): void {
    this.#plan.receipt.events.push(event);
    this.#plan.progress(event);
  }
}

/** What one run's conversation needs: the loaded SDK and tool module, the served tools, the receipt it fills and the prompts. */
interface Conversation {
  readonly sdk: ClaudeAgentSdk;
  readonly served: ClaudeTools;
  readonly external: ExternalTools | null;
  readonly discoveryTools: readonly ServedTool[];
  readonly receipt: ClaudeCodeDiscoveryReceipt;
  readonly settings: DiscoverySettings;
  readonly signal: AbortSignal;
  readonly progress: (event: DiscoveryEvent) => void;
  readonly systemPrompt: string;
  readonly message: string;
}

/** Settings the Claude Code runner needs besides each build's model and level. */
export interface ClaudeCodeRunnerConfig {
  readonly claudeCode: ClaudeCodeConfig;
  readonly promptTemplatePath: string;
  readonly mcp: McpReference | null;
  /** A private directory Claude Code runs in. Claude Code keeps a log folder per working directory, so every run shares this one. */
  readonly workingDirectory: string;
}

/**
 * Runs discovery through Claude Code with the Claude Agent SDK. Claude Code receives mipmux's rendered discovery policy as
 * its whole system prompt and no tools but mipmux's discovery tools and the allowlisted tools of the configured external
 * MCP servers, which mipmux connects itself and serves in process.
 */
export class ClaudeCodeRunner {
  readonly #config: ClaudeCodeRunnerConfig;
  readonly #supervisor: ProcessSupervisor;
  readonly #renderPrompt: DiscoveryPromptRenderer;
  constructor(config: ClaudeCodeRunnerConfig, supervisor: ProcessSupervisor, renderPrompt: DiscoveryPromptRenderer) {
    this.#config = config;
    this.#supervisor = supervisor;
    this.#renderPrompt = renderPrompt;
  }

  /** The `claude-code/` references for the models Claude Code offers the signed-in account, listed without a model request. */
  async listModels(signal: AbortSignal): Promise<string[]> {
    signal.throwIfAborted();
    const sdk = await loadClaudeAgentSdk();
    await mkdir(this.#config.workingDirectory, { recursive: true, mode: 0o700 });
    const process = new ClaudeCodeProcess(sdk, this.#options(new AbortController()), this.#supervisor, this.#config.workingDirectory);
    const stop = () => { process.end(); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      const models = await process.query.supportedModels();
      return [...new Set(models.map(model => `${claudeCodeProvider}/${modelName(model)}`))].sort();
    } finally {
      signal.removeEventListener('abort', stop);
      process.end();
      await process.closed();
    }
  }

  async run(input: DiscoveryInput, tools: DiscoveryTools, signal: AbortSignal, progress: (event: DiscoveryEvent) => void,
    settings: DiscoverySettings): Promise<DiscoveryOutcome<ClaudeCodeDiscoveryReceipt>> {
    signal.throwIfAborted();
    const sdk = await loadClaudeAgentSdk();
    // Loaded here so that commands that never run Claude Code, such as verify, load no MCP transport package.
    const served = await import('./claude-tools.js');
    const { templateIdentity, prepared } = await prepareDiscoveryRun(this.#config.promptTemplatePath, input, false, mipmuxToolPrefix,
      signal, this.#renderPrompt);
    const mcp = await admitRunMcp(this.#config.mcp, signal);
    if (mcp && Object.hasOwn(mcp.configuration.mcpServers, 'mipmux')) throw new WorkspaceFailure('invalidMcpConfiguration', { server: 'mipmux' });
    await mkdir(this.#config.workingDirectory, { recursive: true, mode: 0o700 });
    const receipt = this.#receipt(settings, templateIdentity, prepared.systemPrompt, mcp);
    let external: ExternalTools | null;
    try { external = mcp && await served.connectExternalTools(mcp, signal); }
    catch (error) {
      if (receipt.mcp) receipt.mcp.readiness = { state: 'unavailable' };
      return this.#outcome(receipt, signal, failureCode(error));
    }
    const message = prepared.message + '\n\n<mipmux_runtime>\n' + input.initialContext + '\n</mipmux_runtime>';
    const failure = await this.#converse({ sdk, served, external, receipt, settings, signal, progress, message,
      systemPrompt: prepared.systemPrompt, discoveryTools: this.#discoveryTools(served, input, tools, signal) });
    return this.#outcome(receipt, signal, failure);
  }

  #outcome(receipt: ClaudeCodeDiscoveryReceipt, signal: AbortSignal, failure: string | null): DiscoveryOutcome<ClaudeCodeDiscoveryReceipt> {
    if (signal.aborted) return { kind: 'cancelled', code: 'cancelled', receipt: freeze(receipt) };
    if (failure) return { kind: 'failed', code: failure, receipt: freeze(receipt) };
    if (!completeClaudeCodeDiscovery(receipt)) return { kind: 'failed', code: 'incompleteDiscoveryReceipt', receipt: freeze(receipt) };
    return { kind: 'complete', receipt: freeze(receipt) };
  }

  /** Serves the tools, runs the conversation, joins every tool call and disconnects external servers; returns the failure code, or null. */
  async #converse(conversation: Conversation): Promise<string | null> {
    const { served, external, receipt, settings, signal } = conversation;
    const pending = new Set<Promise<unknown>>();
    const track = <T>(work: Promise<T>) => { pending.add(work); void work.finally(() => pending.delete(work)); return work; };
    const servers = new Map<string, readonly ServedTool[]>([['mipmux', conversation.discoveryTools], ...external?.servers ?? []]);
    if (external && receipt.mcp) receipt.mcp.readiness = { state: 'ready', declarationSHA256: external.declarationSHA256,
      tools: [...external.servers].flatMap(([server, list]) => list.map(tool => `mcp__${server}__${tool.name}`)).sort() };
    const abort = new AbortController();
    const options = this.#options(abort);
    options.model = settings.model;
    options.systemPrompt = { type: 'custom', prompt: conversation.systemPrompt };
    options.allowedTools = [...servers.keys()].map(server => `mcp__${server}__*`);
    options.mcpServers = Object.fromEntries([...servers].map(([server, list]) => [server, this.#inProcessServer(served, server,
      list.map(tool => ({ ...tool, call: (args, callSignal) => track(tool.call(args, AbortSignal.any([signal, callSignal]))) })))]));
    if (settings.thinking === 'off') options.thinking = { type: 'disabled' };
    else if (isEffortLevel(settings.thinking)) options.effort = settings.thinking;
    const process = new ClaudeCodeProcess(conversation.sdk, options, this.#supervisor, this.#config.workingDirectory);
    const failure = await new ClaudeCodeRun({ settings, options, receipt, signal, progress: conversation.progress, message: conversation.message,
      servers: new Map([...servers].map(([server, list]) => [server, list.map(tool => tool.name)])) }, process).execute();
    abort.abort();
    await Promise.allSettled([...pending]);
    receipt.toolsSettled = true;
    if (external) {
      await external.close();
      if (receipt.mcp) receipt.mcp.shutdown = 'dispatched';
    }
    return failure;
  }

  #receipt(settings: DiscoverySettings, identity: ClaudeCodeDiscoveryReceipt['policyIdentity'], systemPrompt: string,
    mcp: AdmittedMcp | null): ClaudeCodeDiscoveryReceipt {
    return { adapter: 'mipmux-claude-code-v1', sdk: claudeAgentSdkVersion, claudeCodeVersion: null,
      templateVersion: 'mipmux-discovery-template-v1', template: { path: this.#config.promptTemplatePath, identity },
      policyIdentity: { sha256: sha256(systemPrompt), byteCount: Buffer.byteLength(systemPrompt) },
      requested: { provider: settings.provider, model: settings.model, thinking: settings.thinking }, thinkingLevels: null,
      effective: null, completions: [], events: [], finalAssistant: null, prompt: 'notStarted', result: null,
      childClosed: false, toolsSettled: false, telemetryLimit,
      mcp: mcp && { configSHA256: mcp.configSHA256, servers: Object.entries(mcp.configuration.mcpServers).map(([name, server]) => ({
        name, endpointSHA256: sha256(server.url), tools: Object.keys(server.toolExposure).sort() })),
      readiness: { state: 'notObserved' }, shutdown: 'notObserved' } };
  }

  /** mipmux's discovery tools as Claude Code sees them; each call is checked against its exact schema and answered by `tools`. */
  #discoveryTools(served: ClaudeTools, input: DiscoveryInput, tools: DiscoveryTools, signal: AbortSignal): ServedTool[] {
    return Object.entries(toolSchemas).filter(([name]) => name !== 'ask_user' || input.clarification !== undefined).map(([name, schema]) => ({
      name, description: toolDescription(name), inputSchema: advertisedSchema(schema),
      call: async (args, callSignal) => {
        const call = callValidator.Default({ name, input: args });
        if (!callValidator.Check(call)) return { ...piToolResult(failureResult(new WorkspaceFailure('invalidRequest'))), isError: true };
        try { return piToolResult(await tools.call(call, AbortSignal.any([signal, callSignal]), piToolResult)); }
        catch (error) { return { ...piToolResult(failureResult(error)), isError: true }; }
      },
    }));
  }

  #inProcessServer(served: ClaudeTools, name: string, tools: readonly ServedTool[]): McpSdkServerConfigWithInstance {
    const server: McpServer = served.servedToolServer(name, tools);
    // SAFETY: the SDK's type names MCP SDK 1.x's McpServer, but the SDK only connects and closes the instance, which mipmux's
    // MCP 2.x McpServer supports; the runner tests run every tool through it.
    const instance: McpSdkServerConfigWithInstance['instance'] = server as never;
    return { type: 'sdk', name, instance, timeout: maximumToolCallMs };
  }

  /** The options every Claude Code process starts with: no built-in tools, settings, skills or other MCP servers, and nothing saved. */
  #options(abort: AbortController): Options {
    const options: Options = { cwd: this.#config.workingDirectory, tools: [], settingSources: [], skills: [], strictMcpConfig: true,
      persistSession: false, permissionMode: 'dontAsk', abortController: abort, mcpServers: {},
      env: { ...this.#config.claudeCode.environment, ...childSettings } };
    if (this.#config.claudeCode.executable) options.pathToClaudeCodeExecutable = this.#config.claudeCode.executable;
    return options;
  }
}
