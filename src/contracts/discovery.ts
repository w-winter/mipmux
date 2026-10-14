import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { SafeCount, SHA256 } from './workspace.js';
import { ReadRequest, TreeRequest, ScopedStructure, SearchRequest, ReadInput, StructureInput, SearchInput, Continuation } from './exploration.js';
import { GitRequest, GitInput } from './git.js';
import { ContextBuildRequest, DraftInspection, DraftUpdate, DraftPreview, PromptRequest } from './context.js';
import { SelectionInput, SelectionRequest } from './selection.js';

const closed = { additionalProperties: false };
export const DiscoveryInput = Type.Object({ tokenBudget: SafeCount, purpose: ContextBuildRequest.properties.purpose,
  enhancementMode: ContextBuildRequest.properties.enhancementMode,
  task: Type.String(), constraints: Type.String(), hints: Type.Array(Type.String()), roots: Type.Array(Type.String()),
  initialContext: Type.String({ minLength: 1 }) }, closed);
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
export const toolSchemas = { git: Type.Union(GitInput.anyOf.map(schema => Type.Object({ ...schema.properties, maxOutputBytes: Positive }, closed))), get_file_tree: Type.Union([
  Type.Object({ ...TreeInput.anyOf[0].properties, maxOutputBytes: Positive }, closed),
  Type.Object({ ...TreeInput.anyOf[1].properties, maxOutputBytes: Positive }, closed),
]),
  get_code_structure: Type.Object({ ...StructureInput.properties, maxOutputBytes: Positive }, closed),
  file_search: Type.Union(SearchInput.anyOf.map(schema => Type.Object({ ...schema.properties, maxOutputBytes: Positive }, closed))),
  read_file: Type.Union(ReadInput.anyOf.map(schema => Type.Object({ ...schema.properties, maxOutputBytes: Positive }, closed))), draft_inspect: DraftInspection,
  draft_update: DraftUpdate, draft_preview: DraftPreview, draft_validate: ValidateRequest, prompt: PromptRequest,
  manage_selection: Type.Object({ ...SelectionInput.properties, maxOutputBytes: Positive }, closed) };
export const DiscoveryCall = Type.Union([
  Type.Object({ name: Type.Literal('git'), input: GitRequest }, closed),
  Type.Object({ name: Type.Literal('get_file_tree'), input: ScopedTree }, closed),
  Type.Object({ name: Type.Literal('get_code_structure'), input: ScopedStructure }, closed),
  Type.Object({ name: Type.Literal('file_search'), input: SearchRequest }, closed),
  Type.Object({ name: Type.Literal('read_file'), input: ReadRequest }, closed),
  Type.Object({ name: Type.Literal('draft_inspect'), input: DraftInspection }, closed),
  Type.Object({ name: Type.Literal('draft_update'), input: DraftUpdate }, closed),
  Type.Object({ name: Type.Literal('draft_preview'), input: DraftPreview }, closed),
  Type.Object({ name: Type.Literal('draft_validate'), input: ValidateRequest }, closed),
  Type.Object({ name: Type.Literal('prompt'), input: PromptRequest }, closed),
  Type.Object({ name: Type.Literal('manage_selection'), input: SelectionRequest }, closed),
]);
export type DiscoveryCall = Static<typeof DiscoveryCall>;
export const callValidator = Compile(DiscoveryCall);
export const RecoveryPolicy = Type.Object({
  retry: Type.Object({ enabled: Type.Boolean(), maxRetries: SafeCount, baseDelayMs: SafeCount,
    maxAgentDelayMs: SafeCount, provider: Type.Object({ timeoutMs: Positive, maxRetries: SafeCount,
      maxRetryDelayMs: SafeCount }, closed) }, closed),
  compaction: Type.Object({ enabled: Type.Boolean(), reserveTokens: SafeCount, keepRecentTokens: SafeCount }, closed),
  transport: Type.Enum(['auto', 'sse', 'websocket', 'websocket-cached']),
  httpIdleTimeoutMs: SafeCount, websocketConnectTimeoutMs: SafeCount, cacheWarming: Type.Literal('off'),
}, closed);
export const ModelIdentity = Type.Object({ provider: Type.String(), model: Type.String(), api: Type.String() }, closed);
export const Completion = Type.Object({ dispatched: ModelIdentity, reported: ModelIdentity,
  serverModel: Type.Union([Type.String(), Type.Null()]),
  stopReason: Type.Enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']),
  channel: Type.Enum(['ordinary', 'summary']), textBytes: SafeCount, textSHA256: SHA256,
  textOnly: Type.Boolean(), nonempty: Type.Boolean(), diagnostics: Type.Array(Type.String()),
}, closed);
export type Completion = Static<typeof Completion>;
export const DiscoveryEvent = Type.Object({ kind: Type.String(),
  attempt: Type.Union([SafeCount, Type.Null()]), delayMs: Type.Union([SafeCount, Type.Null()]),
  success: Type.Union([Type.Boolean(), Type.Null()]), reason: Type.Union([Type.String(), Type.Null()]),
}, closed);
export type DiscoveryEvent = Static<typeof DiscoveryEvent>;
const McpReceipt = Type.Object({ configSHA256: SHA256,
  servers: Type.Array(Type.Object({ name: Type.String(), endpointSHA256: SHA256, tools: Type.Array(Type.String()) }, closed)),
  readiness: Type.Union([
    Type.Object({ state: Type.Literal('notObserved') }, closed),
    Type.Object({ state: Type.Literal('ready'), tools: Type.Array(Type.String()), declarationSHA256: SHA256 }, closed),
    Type.Object({ state: Type.Literal('unavailable') }, closed),
  ]),
  shutdown: Type.Enum(['notObserved', 'dispatched', 'handlerFailed']),
}, closed);
export const DiscoveryReceipt = Type.Object({
  adapter: Type.String(), sdk: Type.String(), buildLockSHA256: SHA256,
  promptVersion: Type.String(), promptSHA256: SHA256,
  requested: Type.Object({ provider: Type.String(), model: Type.String(), thinking: Type.String() }, closed),
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
export type DiscoveryReceipt = Static<typeof DiscoveryReceipt>;
