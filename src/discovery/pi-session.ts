import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { createAgentSession, SessionManager, SettingsManager,
  type AgentSession, type ResourceLoader, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { lazyStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Completion, DiscoveryEvent, DiscoveryReceipt } from '../contracts/discovery.js';
import type { DiscoverySessionInput as DiscoveryInput } from './pi-protocol.js';
import type { Evidence, PiConfig } from './pi-protocol.js';
import { canonicalJSON, sha256, freeze, WorkspaceFailure } from '../workspace/values.js';
import { createDiscoveryModels } from './discovery-models.js';
import type { AdmittedMcp } from './mcp-config.js';
import { CODEMODE_TOOL, loadDiscoveryExtensions } from './discovery-extensions.js';
import { advertisedSchema } from './advertised-schema.js';
import { checkServerModel } from './completion.js';

const modelRecordValidator = Compile(Type.Record(Type.String(), Type.Unknown()));
/** The Pi API whose models have shown that they call tools whose schema is a union at its root: OpenAI Codex's. */
const unionRootApi = 'openai-codex-responses';

/** An OpenAI chat-completions stream chunk that names a model; a served model can be declared only for that API. */
const namedModelChunk = Compile(Type.Object({ model: Type.String({ minLength: 1 }) }));

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
    const models = await createDiscoveryModels(config, signal);
    const selected = models.runtime.getPhysicalModel(config.provider, config.model);
    if (!selected) throw new WorkspaceFailure('modelUnavailable');
    const model = freeze(structuredClone(selected));
    const identity = { provider: model.provider, model: model.id, api: model.api };
    const expectedServerModel = models.expectedServerModel(model.provider, model.id);
    // Other routes lose a union at a schema's root: Pi's Anthropic conversion keeps only root properties, and Gemini
    // through OpenRouter nests its arguments. Their models get the flattened schema; the worker checks each call exactly.
    const offered = model.api === unionRootApi ? tools : tools.map(tool => ({ ...tool, parameters: advertisedSchema(tool.parameters) }));
    const settings = SettingsManager.inMemory(config.policy);
    const extensions = await loadDiscoveryExtensions(mcp, settings, config.codemode);
    const resources: ResourceLoader = {
      getExtensions: () => extensions,
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => prompt, getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources: () => {}, reload: async () => {},
    };
    const thinking: ThinkingLevel = config.thinking;
    // The model is offered mipmux's tools and, when configured, codemode; scripts can call only mipmux's tools.
    const scriptable = tools.map(tool => tool.name), toolNames = config.codemode ? [...scriptable, CODEMODE_TOOL] : scriptable;
    const created = await createAgentSession({ cwd: '/', agentDir: '/', modelRuntime: models.runtime, model,
      thinkingLevel: thinking, sessionManager: SessionManager.inMemory('/'), settingsManager: settings,
      resourceLoader: resources, ...(mcp ? { noTools: 'builtin' as const } : { tools: toolNames }), customTools: offered });
    session = created.session;
    // Naming codemode in the allowlist activates it; without an allowlist, as with MCP, it registers inactive.
    if (mcp && config.codemode) session.setActiveToolsByName([...session.getActiveToolNames(), CODEMODE_TOOL]);
    observe({ kind: 'modelCapabilities', thinkingLevels: session.getAvailableThinkingLevels() });
    // compat-ok: Pi reports a substituted model through modelFallbackMessage; discovery fails rather than run another model.
    if (created.modelFallbackMessage || JSON.stringify(session.model) !== JSON.stringify(model)) throw new WorkspaceFailure('modelSelectionChanged');
    // Pi clamps a level the model does not support to the nearest supported one, which would change the requested setting.
    if (session.thinkingLevel !== thinking) throw new WorkspaceFailure('unsupportedThinkingLevel');
    if (canonicalJSON(session.getActiveToolNames().sort()) !== canonicalJSON([...toolNames].sort()) ||
        canonicalJSON(session.getCallableToolNames().sort()) !== canonicalJSON([...scriptable].sort())) {
      throw new WorkspaceFailure('unexpectedToolAccess');
    }
    const { baseUrl, headers, ...metadata } = model;
    const modelRecord: unknown = JSON.parse(JSON.stringify(metadata));
    if (!modelRecordValidator.Check(modelRecord)) throw new WorkspaceFailure('invalidModelConfiguration');
    const effective: DiscoveryReceipt['effective'] = { identity, thinking, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      recordSHA256: sha256(canonicalJSON(JSON.parse(JSON.stringify(model)))), modelRecord,
      endpointSHA256: sha256(baseUrl), headersSHA256: headers ? sha256(canonicalJSON(headers)) : null, expectedServerModel };
    observe({ kind: 'preflight', effective, policy: { ...config.policy, compaction: settings.getCompactionSettings(model) } });
    // The model IDs each response's stream chunks named, recorded only for a declared served model.
    const reportedModels = new WeakMap<AssistantMessage, string[]>();
    const completion = (message: AssistantMessage, channel: 'ordinary' | 'summary'): Completion => {
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      return { dispatched: identity, reported: { provider: message.provider, model: message.model, api: message.api },
        serverModel: message.provider === 'openai-codex' ? null : message.responseModel ?? null,
        reportedServerModels: expectedServerModel === null ? null : reportedModels.get(message) ?? [],
        stopReason: message.stopReason, channel, textBytes: Buffer.byteLength(text), textSHA256: sha256(text),
        textOnly: message.content.every(block => block.type === 'text' || block.type === 'thinking'),
        nonempty: text.trim().length > 0, diagnostics: message.diagnostics?.map(item => item.type) ?? [],
        usage: { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite },
        toolCalls: message.content.flatMap(block => block.type === 'toolCall' ? [block.name] : []) };
    };
    const activeSession = session;
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = async (dispatched, context, options) => {
      if (JSON.stringify(dispatched) !== JSON.stringify(model)) throw new WorkspaceFailure('modelSelectionChanged');
      if (failure) {
        const code = failure;
        return lazyStream(dispatched, async () => { throw new WorkspaceFailure(code); });
      }
      if (mcp) {
        const direct = activeSession.getAllTools().filter(tool => tool.name.startsWith('mcp__') && tool.exposure === 'direct');
        const directNames = direct.map(tool => tool.name);
        const selectedCount = Object.values(mcp.configuration.mcpServers).reduce((count, server) => count + Object.keys(server.toolExposure).length, 0);
        if (direct.length !== selectedCount || canonicalJSON(activeSession.getActiveToolNames().sort()) !== canonicalJSON([...toolNames, ...directNames].sort()) ||
            canonicalJSON(activeSession.getCallableToolNames().sort()) !== canonicalJSON([...scriptable, ...directNames].sort())) {
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
      const reported: string[] = [];
      // Pi's own handler, which forwards raw events to extensions, still receives every chunk.
      const observed: typeof options = expectedServerModel === null ? options : { ...options, onProviderStreamEvent: async (chunk, eventModel) => {
        if (namedModelChunk.Check(chunk) && !reported.includes(chunk.model)) reported.push(chunk.model);
        await options?.onProviderStreamEvent?.(chunk, eventModel);
      } };
      const result = await stream(dispatched, context, observed);
      // This reaction runs before Pi's agent loop ends the message or runs its tools. A failed check aborts the session there,
      // and the failure gate above refuses any request Pi still dispatches.
      observations.push(result.result().then(message => {
        reportedModels.set(message, reported);
        const fact = completion(message, channel);
        observe({ kind: 'completion', value: fact });
        const check = checkServerModel(fact, identity.model, expectedServerModel);
        if (check === 'matched') return;
        failure ??= check === 'mismatched' ? 'modelIdentityMismatch' : 'modelIdentityUnavailable';
        return activeSession.abort();
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
