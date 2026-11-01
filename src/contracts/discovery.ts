import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { SafeCount, SHA256, SourceIdentity } from './workspace.js';
import { ReadRequest, TreeRequest, ScopedStructure, SearchRequest, ReadInput, StructureInput, SearchInput, Continuation } from './exploration.js';
import { GitRequest, GitInput } from './git.js';
import { ContextBuildRequest, CapturedContextBuildRequest, DraftInspection, DraftUpdate, PromptRequest } from './context.js';
import { SelectionInput, SelectionRequest } from './selection.js';
import { AskUserRequest } from './interaction.js';

const closed = { additionalProperties: false };
export const ThinkingLevel = Type.Enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ThinkingLevel = Static<typeof ThinkingLevel>;
/** Pi's `provider/model` notation: the provider is the text before the first `/`, and the model ID, which may contain `/`, follows it. */
export const ModelReference = Type.String({ pattern: '^[^/\\s]+/\\S+$' });
/**
 * A build's choice of discovery model and thinking level. `model` must be the configured model or one of the configured
 * allowed models; an omitted field keeps the configured value.
 */
export const DiscoverySelection = Type.Object({ model: Type.Optional(ModelReference), thinking: Type.Optional(ThinkingLevel) }, closed);
export type DiscoverySelection = Static<typeof DiscoverySelection>;
export const DiscoveryInput = Type.Object({ tokenBudget: SafeCount, purpose: ContextBuildRequest.properties.purpose,
  clarification: Type.Optional(Type.Object({ questionTimeoutSeconds: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, closed)),
  enhancementMode: CapturedContextBuildRequest.properties.enhancementMode,
  task: Type.String(), constraints: Type.String(), hints: Type.Array(Type.String()), roots: Type.Array(Type.String()),
  initialContext: Type.String({ minLength: 1 }), fileTree: Type.String(), currentPrompt: Type.String(),
  restrictsReviewGitToExplicitReadOnly: Type.Boolean() }, closed);
type DiscoveryInputFields = Static<typeof DiscoveryInput>;
export type DiscoveryInput = { readonly [K in keyof DiscoveryInputFields]: Readonly<DiscoveryInputFields[K]> };
export const Positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const ScopedTree = Type.Union([
  Type.Omit(TreeRequest.anyOf[0], ['selection']), Type.Omit(TreeRequest.anyOf[1], ['selection']),
]);
export const TreeInput = Type.Union([
  Type.Object({ ...Type.Partial(Type.Omit(ScopedTree.anyOf[0], ['maxOutputBytes', 'type'])).properties,
    type: ScopedTree.anyOf[0].properties.type }, closed),
  Type.Partial(Type.Omit(ScopedTree.anyOf[1], ['maxOutputBytes']), closed),
]);
export const ValidateRequest = Type.Object({ maxOutputBytes: Positive }, closed);
export const toolSchemas = { ask_user: AskUserRequest, git: Type.Union(GitInput.anyOf.map(schema => Type.Object({ ...schema.properties, maxOutputBytes: Positive }, closed))), get_file_tree: Type.Union([
  Type.Object({ ...TreeInput.anyOf[0].properties, maxOutputBytes: Positive }, closed),
  Type.Object({ ...TreeInput.anyOf[1].properties, maxOutputBytes: Positive }, closed),
]),
  get_code_structure: Type.Object({ ...StructureInput.properties, maxOutputBytes: Positive }, closed),
  file_search: Type.Union(SearchInput.anyOf.map(schema => Type.Object({ ...schema.properties, maxOutputBytes: Positive }, closed))),
  read_file: Type.Union(ReadInput.anyOf.map(schema => Type.Object({ ...schema.properties, maxOutputBytes: Positive }, closed))), draft_inspect: DraftInspection,
  draft_update: DraftUpdate, draft_validate: ValidateRequest, prompt: PromptRequest,
  manage_selection: Type.Object({ ...SelectionInput.properties, maxOutputBytes: Positive }, closed) };
export const DiscoveryCall = Type.Union([
  Type.Object({ name: Type.Literal('ask_user'), input: AskUserRequest }, closed),
  Type.Object({ name: Type.Literal('git'), input: GitRequest }, closed),
  Type.Object({ name: Type.Literal('get_file_tree'), input: ScopedTree }, closed),
  Type.Object({ name: Type.Literal('get_code_structure'), input: ScopedStructure }, closed),
  Type.Object({ name: Type.Literal('file_search'), input: SearchRequest }, closed),
  Type.Object({ name: Type.Literal('read_file'), input: ReadRequest }, closed),
  Type.Object({ name: Type.Literal('draft_inspect'), input: DraftInspection }, closed),
  Type.Object({ name: Type.Literal('draft_update'), input: DraftUpdate }, closed),
  Type.Object({ name: Type.Literal('draft_validate'), input: ValidateRequest }, closed),
  Type.Object({ name: Type.Literal('prompt'), input: PromptRequest }, closed),
  Type.Object({ name: Type.Literal('manage_selection'), input: SelectionRequest }, closed),
]);
export type DiscoveryCall = Static<typeof DiscoveryCall>;
export const callValidator = Compile(DiscoveryCall);
export const RecoveryPolicy = Type.Object({
  retry: Type.Object({ enabled: Type.Boolean(), maxRetries: SafeCount, baseDelayMs: SafeCount,
    maxAgentDelayMs: SafeCount, provider: Type.Object({ timeoutMs: SafeCount, maxRetries: SafeCount,
      maxRetryDelayMs: SafeCount }, closed) }, closed),
  compaction: Type.Object({ enabled: Type.Boolean(), reserveTokens: SafeCount, keepRecentTokens: SafeCount }, closed),
  transport: Type.Enum(['auto', 'sse', 'websocket', 'websocket-cached']),
  httpIdleTimeoutMs: SafeCount, websocketConnectTimeoutMs: SafeCount, cacheWarming: Type.Literal('off'),
}, closed);
export const ModelIdentity = Type.Object({ provider: Type.String(), model: Type.String(), api: Type.String() }, closed);
/** Token counts as the provider reports them for one model response; `input` excludes cached input. */
export const TokenUsage = Type.Object({ input: SafeCount, output: SafeCount, cacheRead: SafeCount, cacheWrite: SafeCount }, closed);
export type TokenUsage = Static<typeof TokenUsage>;
export const Completion = Type.Object({ dispatched: ModelIdentity, reported: ModelIdentity,
  serverModel: Type.Union([Type.String(), Type.Null()]),
  stopReason: Type.Enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']),
  channel: Type.Enum(['ordinary', 'summary']), textBytes: SafeCount, textSHA256: SHA256,
  textOnly: Type.Boolean(), nonempty: Type.Boolean(), diagnostics: Type.Array(Type.String()), usage: TokenUsage,
  /** Names of the tools this response called, in order; calls made inside a codemode script are not listed. */
  toolCalls: Type.Array(Type.String()),
}, closed);
export type Completion = Static<typeof Completion>;
export const DiscoveryEvent = Type.Object({ kind: Type.String(),
  attempt: Type.Union([SafeCount, Type.Null()]), delayMs: Type.Union([SafeCount, Type.Null()]),
  success: Type.Union([Type.Boolean(), Type.Null()]), reason: Type.Union([Type.String(), Type.Null()]),
}, closed);
export type DiscoveryEvent = Static<typeof DiscoveryEvent>;
export const McpReceipt = Type.Object({ configSHA256: SHA256,
  servers: Type.Array(Type.Object({ name: Type.String(), endpointSHA256: SHA256, tools: Type.Array(Type.String()) }, closed)),
  readiness: Type.Union([
    Type.Object({ state: Type.Literal('notObserved') }, closed),
    Type.Object({ state: Type.Literal('ready'), tools: Type.Array(Type.String()), declarationSHA256: SHA256 }, closed),
    Type.Object({ state: Type.Literal('unavailable') }, closed),
  ]),
  shutdown: Type.Enum(['notObserved', 'dispatched', 'handlerFailed']),
}, closed);
/** The template and rendered policy a discovery run used, and the model and level it was asked to use. */
const runFacts = {
  templateVersion: Type.Literal('mipmux-discovery-template-v1'),
  template: Type.Object({ path: Type.String({ pattern: '^/[^\\u0000]*$' }), identity: SourceIdentity }, closed),
  policyIdentity: SourceIdentity,
  requested: Type.Object({ provider: Type.String(), model: Type.String(), thinking: Type.String() }, closed),
};
/** What a Pi discovery run observed through its worker. */
export const PiDiscoveryReceipt = Type.Object({
  adapter: Type.Literal('mipmux-pi-v2'), sdk: Type.String(), buildLockSHA256: SHA256, ...runFacts,
  /** The thinking levels the requested model supports, as Pi reports them; null until the worker has resolved the model. */
  thinkingLevels: Type.Union([Type.Array(Type.String()), Type.Null()]),
  effective: Type.Union([Type.Null(), Type.Object({ identity: ModelIdentity, thinking: Type.String(),
    contextWindow: Positive, maxTokens: Positive, recordSHA256: SHA256,
    modelRecord: Type.Record(Type.String(), Type.Unknown()), endpointSHA256: SHA256,
    headersSHA256: Type.Union([SHA256, Type.Null()]) }, closed)]),
  policy: RecoveryPolicy, completions: Type.Array(Completion), events: Type.Array(DiscoveryEvent),
  finalAssistant: Type.Union([Completion, Type.Null()]),
  prompt: Type.Enum(['notStarted', 'resolved', 'rejected']), acceptedRuns: SafeCount, settled: Type.Boolean(),
  idle: Type.Boolean(), observationsSettled: Type.Boolean(), disposed: Type.Boolean(),
  workerClosed: Type.Boolean(), parentToolsSettled: Type.Boolean(),
  telemetryLimit: Type.String(), mcp: Type.Union([McpReceipt, Type.Null()]),
}, closed);
export type PiDiscoveryReceipt = Static<typeof PiDiscoveryReceipt>;
/** What a Claude Code discovery run observed through the Claude Agent SDK. */
export const ClaudeCodeDiscoveryReceipt = Type.Object({
  adapter: Type.Literal('mipmux-claude-code-v1'),
  /** The Claude Agent SDK's version, and Claude Code's as its startup message reports it; null until reported. */
  sdk: Type.String(), claudeCodeVersion: Type.Union([Type.String(), Type.Null()]), ...runFacts,
  /** The effort levels Claude Code lists for the requested model; null until listed. */
  thinkingLevels: Type.Union([Type.Array(Type.String()), Type.Null()]),
  /**
   * From Claude Code's startup message: the model it runs, the model name responses report, where its credential came
   * from (`none` for a Claude login) and the tools the model can call.
   */
  effective: Type.Union([Type.Null(), Type.Object({ model: Type.String(), servedModel: Type.String(), apiKeySource: Type.String(),
    tools: Type.Array(Type.String()) }, closed)]),
  completions: Type.Array(Completion), events: Type.Array(DiscoveryEvent), finalAssistant: Type.Union([Completion, Type.Null()]),
  prompt: Type.Enum(['notStarted', 'resolved', 'rejected']),
  /**
   * Claude Code's closing report: its subtype, turns, duration, cost at list prices in US dollars, summed token usage and
   * the error texts it gave, such as a failed sign-in.
   */
  result: Type.Union([Type.Null(), Type.Object({ subtype: Type.String(), turns: SafeCount, durationMs: SafeCount,
    costUsd: Type.Number({ minimum: 0 }), usage: TokenUsage, errors: Type.Array(Type.String()) }, closed)]),
  childClosed: Type.Boolean(), toolsSettled: Type.Boolean(),
  telemetryLimit: Type.String(), mcp: Type.Union([McpReceipt, Type.Null()]),
}, closed);
export type ClaudeCodeDiscoveryReceipt = Static<typeof ClaudeCodeDiscoveryReceipt>;
export const DiscoveryReceipt = Type.Union([PiDiscoveryReceipt, ClaudeCodeDiscoveryReceipt]);
export type DiscoveryReceipt = Static<typeof DiscoveryReceipt>;
