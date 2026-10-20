import { readFile } from 'node:fs/promises';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ResourceLoader, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { InMemoryModelsStore, lazyStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Completion, DiscoveryEvent, DiscoveryReceipt } from '../contracts/discovery.js';
import type { DiscoverySessionInput as DiscoveryInput } from './pi-protocol.js';
import type { Evidence, PiConfig } from './pi-protocol.js';
import { canonicalJSON, sha256, freeze, WorkspaceFailure } from '../workspace/values.js';
import { createCredentials, rejectCommands } from './pi-credentials.js';
import type { AdmittedMcp } from './mcp-config.js';
import { loadDiscoveryMcp } from './mcp-extension.js';

const closed = { additionalProperties: false };
const modelsValidator = Compile(Type.Object({ providers: Type.Record(Type.String(), Type.Object({
  baseUrl: Type.Optional(Type.String()),
  modelOverrides: Type.Optional(Type.Record(Type.String(), Type.Object({
    contextWindow: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  }, closed))),
}, closed)) }, closed));
const modelRecordValidator = Compile(Type.Record(Type.String(), Type.Unknown()));

/** Reads authorized configuration only; SDK diagnostics are never forwarded to the caller. */
export async function runPiSession(config: PiConfig, input: DiscoveryInput, tools: ToolDefinition[],
  prompt: string, mcp: AdmittedMcp | null, signal: AbortSignal, progress: (event: DiscoveryEvent) => void,
  observe: (fact: Evidence) => void) {
  let session: AgentSession | null = null;
  const observations: Promise<void>[] = [];
  let observationFailed = false;
  let summarizing = false;
  let failure: string | null = null;
  let promptObserved = false;
  let bound = false, readinessObserved = false;
  const extensionErrors: string[] = [];
  const abort = () => { if (session) { observations.push(session.abort().catch(() => { observationFailed = true; })); } };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const models: unknown = JSON.parse(await readFile(config.modelsPath, 'utf8'));
    const auth: unknown = JSON.parse(await readFile(config.authPath, 'utf8'));
    rejectCommands(models); rejectCommands(auth);
    if (!modelsValidator.Check(models)) throw new WorkspaceFailure('unsupportedModelConfiguration');
    const credentials = await createCredentials(config.authPath, signal);
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
      modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false, signal });
    for (const [provider, data] of Object.entries(models.providers)) {
      if (!runtime.getProvider(provider)) throw new WorkspaceFailure('unsupportedModelConfiguration');
      runtime.registerProvider(provider, { models: runtime.getAllModels(provider).map(model => ({
        ...model, ...(model.type === 'chat' ? data.modelOverrides?.[model.id] : {}),
        baseUrl: data.baseUrl ?? model.baseUrl,
      })) });
    }
    if (runtime.getError()) throw new WorkspaceFailure('invalidModelConfiguration');
    const selected = runtime.getPhysicalModel(config.provider, config.model);
    if (!selected) throw new WorkspaceFailure('modelUnavailable');
    const model = freeze(structuredClone(selected));
    const identity = { provider: model.provider, model: model.id, api: model.api };
    const settings = SettingsManager.inMemory(config.policy);
    const extensions = mcp ? await loadDiscoveryMcp(mcp, settings) : null;
    const resources: ResourceLoader = {
      getExtensions: () => extensions ?? ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => prompt, getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources: () => {}, reload: async () => {},
    };
    const thinking: ThinkingLevel = config.thinking;
    const created = await createAgentSession({ cwd: '/', agentDir: '/', modelRuntime: runtime, model,
      thinkingLevel: thinking, sessionManager: SessionManager.inMemory('/'), settingsManager: settings,
      resourceLoader: resources, ...(mcp ? { noTools: 'builtin' as const } : { tools: tools.map(tool => tool.name) }), customTools: tools });
    session = created.session;
    if (created.modelFallbackMessage || session.thinkingLevel !== thinking || JSON.stringify(session.model) !== JSON.stringify(model)) {
      throw new WorkspaceFailure('modelSelectionChanged');
    }
    if (canonicalJSON(session.getActiveToolNames().sort()) !== canonicalJSON(tools.map(tool => tool.name).sort()) ||
        canonicalJSON(session.getCallableToolNames().sort()) !== canonicalJSON(tools.map(tool => tool.name).sort())) {
      throw new WorkspaceFailure('unexpectedToolAccess');
    }
    const { baseUrl, headers, ...metadata } = model;
    const modelRecord: unknown = JSON.parse(JSON.stringify(metadata));
    if (!modelRecordValidator.Check(modelRecord)) throw new WorkspaceFailure('invalidModelConfiguration');
    const effective: DiscoveryReceipt['effective'] = { identity, thinking, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      recordSHA256: sha256(canonicalJSON(JSON.parse(JSON.stringify(model)))), modelRecord,
      endpointSHA256: sha256(baseUrl), headersSHA256: headers ? sha256(canonicalJSON(headers)) : null };
    observe({ kind: 'preflight', effective, policy: { ...config.policy, compaction: settings.getCompactionSettings(model) } });
    const completion = (message: AssistantMessage, channel: 'ordinary' | 'summary'): Completion => {
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      return { dispatched: identity, reported: { provider: message.provider, model: message.model, api: message.api },
        serverModel: message.provider === 'openai-codex' ? null : message.responseModel ?? null,
        stopReason: message.stopReason, channel, textBytes: Buffer.byteLength(text), textSHA256: sha256(text),
        textOnly: message.content.every(block => block.type === 'text' || block.type === 'thinking'),
        nonempty: text.trim().length > 0, diagnostics: message.diagnostics?.map(item => item.type) ?? [] };
    };
    const activeSession = session;
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = async (dispatched, context, options) => {
      if (JSON.stringify(dispatched) !== JSON.stringify(model)) throw new WorkspaceFailure('modelSelectionChanged');
      if (mcp) {
        const direct = activeSession.getAllTools().filter(tool => tool.name.startsWith('mcp__') && tool.exposure === 'direct');
        const expected = [...tools.map(tool => tool.name), ...direct.map(tool => tool.name)].sort();
        const selectedCount = Object.values(mcp.configuration.mcpServers).reduce((count, server) => count + Object.keys(server.toolExposure).length, 0);
        if (failure || direct.length !== selectedCount || canonicalJSON(activeSession.getActiveToolNames().sort()) !== canonicalJSON(expected) ||
            canonicalJSON(activeSession.getCallableToolNames().sort()) !== canonicalJSON(expected)) {
          failure ??= 'mcpToolsUnavailable';
          observe({ kind: 'mcpReadiness', value: { state: 'unavailable' } });
          const code = failure;
          return lazyStream(dispatched, async () => { throw new WorkspaceFailure(code); });
        }
        if (!readinessObserved) {
          readinessObserved = true;
          observe({ kind: 'mcpReadiness', value: { state: 'ready', tools: direct.map(tool => tool.name).sort(),
            declarationSHA256: sha256(canonicalJSON(direct.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
              .sort((a, b) => a.name.localeCompare(b.name)))) } });
        }
      }
      const channel = summarizing ? 'summary' : 'ordinary';
      const result = await stream(dispatched, context, options);
      observations.push(result.result().then(message => {
        const fact = completion(message, channel);
        observe({ kind: 'completion', value: fact });
      }).catch(() => { observationFailed = true; }));
      return result;
    };
    session.subscribe(event => {
      try {
        if (event.type === 'agent_settled') observe({ kind: 'lifecycle', stage: 'settled' });
        if (event.type === 'message_end' && event.message.role === 'assistant') observe({ kind: 'assistant', value: completion(event.message, 'ordinary') });
        if (event.type === 'compaction_start') summarizing = true;
        if (event.type === 'compaction_end') summarizing = false;
        if (event.type.startsWith('auto_retry_') || event.type.startsWith('compaction_') || event.type.startsWith('summarization_retry_')) {
          const fact: DiscoveryEvent = { kind: event.type,
            attempt: 'attempt' in event ? event.attempt : null,
            delayMs: 'delayMs' in event ? event.delayMs : null,
            success: 'success' in event ? event.success : event.type === 'compaction_end' ? event.result !== undefined && !event.aborted : null,
            reason: 'reason' in event ? event.reason : null };
          progress(fact);
        }
      } catch { observationFailed = true; }
    });
    if (mcp) {
      bound = true;
      await session.bindExtensions({ onError: error => { extensionErrors.push(error.event); } });
      if (extensionErrors.length) throw new WorkspaceFailure('mcpStartupFailed');
    }
    signal.throwIfAborted();
    try {
      await session.prompt(input.message + '\n\n<mipmux_runtime>\n' + input.initialContext + '\n</mipmux_runtime>', { expandPromptTemplates: false,
        preflightResult: result => { if (result === 'started') observe({ kind: 'lifecycle', stage: 'accepted' }); } });
      observe({ kind: 'prompt', outcome: 'resolved' }); promptObserved = true;
    }
    catch { observe({ kind: 'prompt', outcome: 'rejected' }); promptObserved = true; failure ??= 'promptFailed'; }
    await session.waitForIdle();
    observe({ kind: 'lifecycle', stage: 'idle' });
  } catch (error) {
    failure = error instanceof WorkspaceFailure ? error.code : 'discoveryPreflightFailed';
    if (!promptObserved) observe({ kind: 'prompt', outcome: 'rejected' });
  } finally {
    signal.removeEventListener('abort', abort);
    await Promise.all(observations);
    observe({ kind: 'lifecycle', stage: 'observationsSettled' });
    if (session) {
      if (bound) {
        const before = extensionErrors.length;
        try {
          await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
          const failed = extensionErrors.slice(before).includes('session_shutdown');
          observe({ kind: 'mcpShutdown', outcome: failed ? 'handlerFailed' : 'dispatched' });
          if (failed) failure ??= 'mcpShutdownFailed';
        } catch { failure ??= 'mcpShutdownFailed'; }
      }
      try { session.dispose(); observe({ kind: 'lifecycle', stage: 'disposed' }); } catch { failure = 'disposalFailed'; }
    }
  }
  if (signal.aborted) return { outcome: 'cancelled' as const, code: 'cancelled' };
  return { outcome: failure === null && !observationFailed ? 'complete' as const : 'failed' as const,
    code: failure ?? (observationFailed ? 'incompleteModelOutput' : '') };
}
