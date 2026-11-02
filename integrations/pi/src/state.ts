import Type, { type Static, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';

/*
 * The extension's settings model and the rules it applies to mipmux calls. Everything here is pure: callers supply the
 * session state, the selected saved workspace and the call's arguments, and the rules mutate only those arguments.
 */
const closed = { additionalProperties: false };
const absolutePath = Type.String({ pattern: '^/' });
export const ThinkingLevel = Type.Enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ThinkingLevel = Static<typeof ThinkingLevel>;
export const EnhancementMode = Type.Enum(['fullRewrite', 'augment', 'preserve']);
export type EnhancementMode = Static<typeof EnhancementMode>;
/** A discovery model in Pi's `provider/model` notation, as mipmux's `discovery.allowedModels` lists it. */
export const ModelReference = Type.String({ pattern: '^[^/\\s]+/\\S+$' });
export const Clarification = Type.Union([
  Type.Object({ enabled: Type.Literal(true), questionTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })) }, closed),
  Type.Object({ enabled: Type.Literal(false) }, closed),
]);
export type Clarification = Static<typeof Clarification>;
const preference = <T extends TSchema>(value: T) => Type.Object({ value, pinned: Type.Boolean() }, closed);
/** A value the user chose; a pinned one also takes precedence over the value the agent sends. */
export interface Preference<T> { readonly value: T; readonly pinned: boolean }
const Root = Type.Object({ name: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]*$' }), absolutePath }, closed);
const Exclusion = Type.Union([
  Type.Object({ kind: Type.Literal('prefix'), root: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }) }, closed),
  Type.Object({ kind: Type.Literal('glob'), root: Type.String({ minLength: 1 }), pattern: Type.String({ minLength: 1 }) }, closed),
]);
/** The declaration a build or prepare call carries: named roots, the output folder and exclusions tied to roots. */
export const Workspace = Type.Object({ roots: Type.Array(Root, { minItems: 1 }), outputRoot: absolutePath, exclusions: Type.Array(Exclusion) }, closed);
export type Workspace = Static<typeof Workspace>;
/**
 * A workspace the user saved under a name, with an optional discovery model and thinking level. It declares no exclusions:
 * the user leaves paths out with each root's `.mipmux_ignore`, which every client and workspace using the folder applies.
 */
export const SavedWorkspace = Type.Object({ name: Type.String({ minLength: 1 }), roots: Workspace.properties.roots,
  outputRoot: Workspace.properties.outputRoot, model: Type.Optional(preference(ModelReference)), thinking: Type.Optional(preference(ThinkingLevel)) }, closed);
export type SavedWorkspace = Static<typeof SavedWorkspace>;
export const Preferences = Type.Object({ budgetUnits: Type.Optional(preference(Type.Integer({ minimum: 1 }))),
  enhancementMode: Type.Optional(preference(EnhancementMode)), clarification: Type.Optional(preference(Clarification)),
  model: Type.Optional(preference(ModelReference)), thinking: Type.Optional(preference(ThinkingLevel)) }, closed);
export type Preferences = Static<typeof Preferences>;
/** What one Pi session records: its selected saved workspace, its preferences and the workspace the agent last declared. */
export const SessionState = Type.Object({ selected: Type.Union([Type.String(), Type.Null()]), preferences: Preferences,
  lastDeclared: Type.Union([Workspace, Type.Null()]) }, closed);
export type SessionState = Static<typeof SessionState>;
export const sessionStateValidator = Compile(SessionState);
export const emptyPreferences: Preferences = {};
export const emptyState: SessionState = { selected: null, preferences: emptyPreferences, lastDeclared: null };

/** The arguments of an MCP call as the agent sent them; the server validates them, and the rules read only the fields they own. */
const CallArguments = Type.Record(Type.String(), Type.Unknown());
export type CallArgs = Static<typeof CallArguments>;
export type Tool = 'context_builder' | 'context_prepare';
/** Where an effective value came from, from highest to lowest precedence. */
export type Source = 'session-pin' | 'workspace-pin' | 'agent' | 'session' | 'workspace' | 'global';
/** The selected saved workspace as the hook found it in the store. */
export type Selection = { readonly kind: 'none' } | { readonly kind: 'found'; readonly workspace: SavedWorkspace } |
  { readonly kind: 'missing'; readonly name: string; readonly saved: readonly string[] } |
  { readonly kind: 'unreadable'; readonly name: string; readonly message: string };
export type Decision = { readonly kind: 'blocked'; readonly reason: string } | { readonly kind: 'allowed'; readonly changed: boolean };
/** A setting's value outside or inside a call, with the layer that supplies it; an undefined value leaves the server's default. */
export interface Effective<T> { readonly value: T | undefined; readonly source: Source }

/** The value a call uses and its source: session pin, saved-workspace pin, agent, session, saved workspace, else the server's global default. */
export function effectiveValue<T>(session: Preference<T> | undefined, workspace: Preference<T> | undefined, agent: T | undefined): Effective<T> {
  if (session?.pinned) return { value: session.value, source: 'session-pin' };
  if (workspace?.pinned) return { value: workspace.value, source: 'workspace-pin' };
  if (agent !== undefined) return { value: agent, source: 'agent' };
  if (session) return { value: session.value, source: 'session' };
  if (workspace) return { value: workspace.value, source: 'workspace' };
  return { value: undefined, source: 'global' };
}

// The call fields the rules read; other fields pass through untouched, and the server validates the whole request.
const BuildFields = Type.Object({ budgetUnits: Type.Optional(Type.Integer()), enhancementMode: Type.Optional(EnhancementMode),
  clarification: Type.Optional(Type.Object({ questionTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })) }, closed)),
  discovery: Type.Optional(Type.Object({ model: Type.Optional(Type.String()), thinking: Type.Optional(ThinkingLevel) }, closed)) });
type BuildFields = Static<typeof BuildFields>;
const buildFields = Compile(BuildFields);
const DeclaredWorkspace = Compile(Type.Object({ ...Workspace.properties, exclusions: Type.Optional(Workspace.properties.exclusions) }, closed));

/** The workspace a call declares, with omitted exclusions as the empty list the server uses; null when it declares none. */
export function declaredWorkspace(args: CallArgs): Workspace | null {
  const declared = args.workspace;
  if (!DeclaredWorkspace.Check(declared)) return null;
  return { roots: declared.roots, outputRoot: declared.outputRoot, exclusions: declared.exclusions ?? [] };
}

/** Whether two declarations are the same workspace to the server, whose key counts root order, root names and exclusion order. */
export function sameWorkspace(declared: Workspace, other: Workspace | null): boolean {
  const key = (workspace: Workspace) => canonical({ roots: workspace.roots, outputRoot: workspace.outputRoot, exclusions: workspace.exclusions });
  return other !== null && key(declared) === key(other);
}

/** The declaration a saved workspace stands for, exactly as the agent must send it. */
export function declaration(workspace: SavedWorkspace): Workspace {
  return { roots: workspace.roots, outputRoot: workspace.outputRoot, exclusions: [] };
}

/** JSON with object keys sorted, so equal values serialize equally whatever their key order. */
function canonical(value: CallArgs): string {
  return JSON.stringify(value, (_key, item) => item instanceof Object && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item);
}

function blockReason(selection: Exclude<Selection, { kind: 'none' | 'found' }>): string {
  return selection.kind === 'missing'
    ? `The selected mipmux workspace "${selection.name}" is no longer saved; the saved workspaces are ${selection.saved.join(', ') || 'none'}. ` +
      'Select one with /mipmux.'
    : `The mipmux extension cannot read its saved workspaces: ${selection.message}. Fix the file or change the selection with /mipmux.`;
}

/** The system prompt section an agent receives while `workspace` is selected. */
export function selectedInstruction(workspace: SavedWorkspace): string {
  return `The user selected the mipmux workspace "${workspace.name}". Send exactly this workspace in every context_builder and ` +
    `context_prepare call: ${JSON.stringify(declaration(workspace))}. A call naming another workspace is blocked; the user changes ` +
    'the selection with /mipmux.';
}

function mismatchReason(workspace: SavedWorkspace): string {
  return `This call names a different mipmux workspace than the one the user selected, "${workspace.name}". Send exactly this ` +
    `workspace: ${JSON.stringify(declaration(workspace))}. Change the selection with /mipmux.`;
}

/**
 * Checks a call against the selected workspace and applies the session's preferences to its arguments in place. A build
 * receives every setting whose effective source is a preference; a preparation receives only a pinned budget. Applying
 * the rules to arguments they already changed changes nothing.
 */
export function decide(tool: Tool, args: CallArgs, selection: Selection, preferences: Preferences, hasUI: boolean): Decision {
  if (selection.kind === 'missing' || selection.kind === 'unreadable') return { kind: 'blocked', reason: blockReason(selection) };
  const workspace = selection.kind === 'found' ? selection.workspace : null;
  if (workspace) {
    const declared = declaredWorkspace(args);
    if (!declared || !sameWorkspace(declared, declaration(workspace))) return { kind: 'blocked', reason: mismatchReason(workspace) };
  }
  const before = canonical(args);
  if (tool === 'context_prepare') {
    if (preferences.budgetUnits?.pinned) args.budgetUnits = preferences.budgetUnits.value;
  } else if (buildFields.Check(args)) applyBuildPreferences(args, preferences, workspace, hasUI);
  return { kind: 'allowed', changed: canonical(args) !== before };
}

/** The value a preference puts into a call, or undefined when the agent's value or the server's default stands. */
function injected<T>(effective: Effective<T>): T | undefined {
  return effective.source === 'agent' ? undefined : effective.value;
}

function applyBuildPreferences(args: BuildFields, preferences: Preferences, workspace: SavedWorkspace | null, hasUI: boolean): void {
  const budget = injected(effectiveValue(preferences.budgetUnits, undefined, args.budgetUnits));
  if (budget !== undefined) args.budgetUnits = budget;
  const mode = injected(effectiveValue(preferences.enhancementMode, undefined, args.enhancementMode));
  if (mode !== undefined) args.enhancementMode = mode;
  if (hasUI) applyClarification(args, preferences);
  applyDiscovery(args, preferences, workspace);
}

/** A disabled preference has no request form, so it removes the agent's request only when pinned. */
function applyClarification(args: BuildFields, preferences: Preferences): void {
  const asked: Clarification | undefined = args.clarification === undefined ? undefined : { enabled: true, ...args.clarification };
  const clarification = injected(effectiveValue(preferences.clarification, undefined, asked));
  if (clarification === undefined) return;
  const { enabled, ...request } = clarification;
  if (enabled) args.clarification = request;
  else delete args.clarification;
}

function applyDiscovery(args: BuildFields, preferences: Preferences, workspace: SavedWorkspace | null): void {
  const discovery = { ...args.discovery };
  const model = injected(effectiveValue(preferences.model, workspace?.model, discovery.model));
  if (model !== undefined) discovery.model = model;
  const thinking = injected(effectiveValue(preferences.thinking, workspace?.thinking, discovery.thinking));
  if (thinking !== undefined) discovery.thinking = thinking;
  if (Object.keys(discovery).length) args.discovery = discovery;
  else delete args.discovery;
}

/** Workspaces are duplicates when their root paths and output folder match, whatever their root order, root names and preferences. */
export function duplicateKey(workspace: Pick<SavedWorkspace, 'roots' | 'outputRoot'>): string {
  return canonical({ roots: workspace.roots.map(root => root.absolutePath).sort(), outputRoot: workspace.outputRoot });
}

/** A saved workspace that a merge removed, with the preferences it carried. */
export interface MergedWorkspace { name: string; droppedModel?: Preference<string>; droppedThinking?: Preference<ThinkingLevel> }
export interface Merge { readonly survivor: string; readonly removed: readonly MergedWorkspace[] }
export interface MergeResult { readonly workspaces: SavedWorkspace[]; readonly merges: Merge[] }

/** Removes later duplicates; the earliest entry of each group survives with its own name and preferences. */
export function mergeDuplicates(workspaces: readonly SavedWorkspace[]): MergeResult {
  const survivors = new Map<string, { workspace: SavedWorkspace; removed: MergedWorkspace[] }>();
  for (const workspace of workspaces) {
    const key = duplicateKey(workspace), survivor = survivors.get(key);
    if (!survivor) { survivors.set(key, { workspace, removed: [] }); continue; }
    const removed: MergedWorkspace = { name: workspace.name };
    if (workspace.model) removed.droppedModel = workspace.model;
    if (workspace.thinking) removed.droppedThinking = workspace.thinking;
    survivor.removed.push(removed);
  }
  const groups = [...survivors.values()];
  return { workspaces: groups.map(group => group.workspace),
    merges: groups.filter(group => group.removed.length).map(group => ({ survivor: group.workspace.name, removed: group.removed })) };
}

/** The text a tool result receives when a start the extension changed conflicts with an earlier job. */
export const conflictNote = 'The mipmux extension applied this session\'s preferences to the request. A start repeated with different preferences ' +
  'conflicts with the earlier job; use a new outputName or restore the earlier preferences.';
