import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { MipmuxConfig } from './config.ts';
import type { MipmuxContext } from './register.ts';
import { readStore, StoreError, updateStore } from './store.ts';
import { duplicateKey, effectiveValue, type Clarification, type EnhancementMode, type Merge, type Preference, type Preferences,
  type SavedWorkspace, type Selection, type SessionState, type Source, type ThinkingLevel, type Workspace } from './state.ts';

/*
 * The /mipmux panel, built from Pi's select, input and confirm dialogs, so it works in the terminal and over RPC. Each
 * menu maps its option labels to actions; each pass rereads the saved workspaces, so the rows show what is stored now.
 */
export interface PanelHost {
  readonly storePath: string;
  state(): SessionState;
  record(state: SessionState, ctx: MipmuxContext): Promise<void>;
  readConfig(): Promise<MipmuxConfig>;
}
type Setting = keyof Preferences;
type Value<K extends Setting> = NonNullable<Preferences[K]>['value'];
type Chooser<T> = (ctx: MipmuxContext, config: MipmuxConfig | null) => Promise<T | undefined>;
/** Option labels in display order, each with the work it starts; `undefined` ends the menu. */
type Menu = Map<string, () => Promise<void>>;
const thinkingLevels: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const enhancementModes: EnhancementMode[] = ['fullRewrite', 'augment', 'preserve'];
const rootNamePattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const wholeNumber = /^[1-9]\d*$/;
const count = (number: number, noun: string) => `${number} ${noun}${number === 1 ? '' : 's'}`;

/** Shows `menu`, runs the chosen action and returns its label; undefined when the user cancels. */
async function run(ctx: MipmuxContext, title: string, menu: Menu): Promise<string | undefined> {
  const choice = await ctx.ui.select(title, [...menu.keys()]);
  const action = choice === undefined ? undefined : menu.get(choice);
  if (!action) return undefined;
  await action();
  return choice;
}
const done = async () => {};

function sourceLabel(source: Source): string {
  switch (source) {
    case 'session-pin': return 'session, pinned';
    case 'workspace-pin': return 'saved workspace, pinned';
    case 'session': return 'session';
    case 'workspace': return 'saved workspace';
    case 'agent': return 'agent';
    case 'global': return 'server default';
  }
}

function formatClarification(value: Clarification): string {
  if (!value.enabled) return 'off';
  return value.questionTimeoutSeconds === undefined ? 'on' : `on, ${value.questionTimeoutSeconds} s question timeout`;
}

function line<T>(label: string, session: Preference<T> | undefined, saved: Preference<T> | undefined, format: (value: T) => string,
  global: string): string {
  const effective = effectiveValue(session, saved, undefined);
  return effective.value === undefined ? `${label}: ${global}` : `${label}: ${format(effective.value)} (${sourceLabel(effective.source)})`;
}

/** One line per setting with its effective value outside any call and the layer that supplies it. */
function settingLines(state: SessionState, workspace: SavedWorkspace | null, config: MipmuxConfig | null) {
  const preferences = state.preferences, discovery = config?.discovery ?? null;
  const global = (value: string | undefined) => value === undefined ? 'server default' : `${value} (server default)`;
  const discoveryGlobal = (value: string | undefined) => config && !discovery ? 'discovery not configured' : global(value);
  const units = (value: number) => `${value} units`;
  return {
    budgetUnits: line('budget', preferences.budgetUnits, undefined, units, global(config ? units(config.contextBudgetUnits) : undefined)),
    enhancementMode: line('enhancement mode', preferences.enhancementMode, undefined, String, global(config?.defaultEnhancementMode)),
    clarification: line('clarification', preferences.clarification, undefined, formatClarification, global('off')),
    model: line('discovery model', preferences.model, workspace?.model, String, discoveryGlobal(discovery?.model)),
    thinking: line('thinking level', preferences.thinking, workspace?.thinking, String, discoveryGlobal(discovery?.thinking)),
  };
}

function workspaceLine(selection: Selection): string {
  switch (selection.kind) {
    case 'none': return 'workspace: none selected';
    case 'found': return `workspace: ${selection.workspace.name}`;
    case 'missing': return `workspace: ${selection.name} (no longer saved)`;
    case 'unreadable': return `workspace: ${selection.name} (${selection.message})`;
  }
}

/** The effective state as text, for sessions without a UI; the server defaults are not read here. */
export function report(state: SessionState, selection: Selection): string {
  const workspace = selection.kind === 'found' ? selection.workspace : null;
  return [workspaceLine(selection), ...Object.values(settingLines(state, workspace, null))].join('\n');
}

/** Reads and replaces one preference in its holder; replacing with null removes it. */
interface Field<Holder, T> {
  get(holder: Holder): Preference<T> | undefined;
  set(holder: Holder, preference: Preference<T> | null): Holder;
}
const sessionFields = {
  budgetUnits: { get: preferences => preferences.budgetUnits,
    set: ({ budgetUnits: _removed, ...rest }, preference) => preference ? { ...rest, budgetUnits: preference } : rest },
  enhancementMode: { get: preferences => preferences.enhancementMode,
    set: ({ enhancementMode: _removed, ...rest }, preference) => preference ? { ...rest, enhancementMode: preference } : rest },
  clarification: { get: preferences => preferences.clarification,
    set: ({ clarification: _removed, ...rest }, preference) => preference ? { ...rest, clarification: preference } : rest },
  model: { get: preferences => preferences.model,
    set: ({ model: _removed, ...rest }, preference) => preference ? { ...rest, model: preference } : rest },
  thinking: { get: preferences => preferences.thinking,
    set: ({ thinking: _removed, ...rest }, preference) => preference ? { ...rest, thinking: preference } : rest },
} satisfies { [K in Setting]: Field<Preferences, Value<K>> };
const workspaceModel: Field<SavedWorkspace, string> = { get: workspace => workspace.model,
  set: ({ model: _removed, ...rest }, preference) => preference ? { ...rest, model: preference } : rest };
const workspaceThinking: Field<SavedWorkspace, ThinkingLevel> = { get: workspace => workspace.thinking,
  set: ({ thinking: _removed, ...rest }, preference) => preference ? { ...rest, thinking: preference } : rest };

function notifyMerges(ctx: MipmuxContext, merges: readonly Merge[]): void {
  for (const merge of merges) {
    const removed = merge.removed.map(entry => entry.name + (entry.droppedModel ? ` (its model ${entry.droppedModel.value} was dropped)` : ''));
    ctx.ui.notify(`Merged duplicate saved workspaces into "${merge.survivor}": removed ${removed.join(', ')}.`, 'info');
  }
}

/** Writes the store and keeps this session on a saved workspace that a merge removed by selecting its survivor. */
async function saveWorkspaces(ctx: MipmuxContext, host: PanelHost, change: (workspaces: SavedWorkspace[]) => SavedWorkspace[]) {
  const result = await updateStore(host.storePath, change);
  notifyMerges(ctx, result.merges);
  const selected = host.state().selected, merge = result.merges.find(entry => entry.removed.some(removed => removed.name === selected));
  if (merge) await host.record({ ...host.state(), selected: merge.survivor }, ctx);
  return result.workspaces;
}

async function wholeNumberInput(ctx: MipmuxContext, title: string, placeholder: string, problem: string): Promise<number | undefined> {
  const text = (await ctx.ui.input(title, placeholder))?.trim();
  if (!text) return undefined;
  if (!wholeNumber.test(text)) { ctx.ui.notify(problem, 'error'); return undefined; }
  return Number(text);
}

async function pick<T extends string>(ctx: MipmuxContext, title: string, options: readonly T[]): Promise<T | undefined> {
  const choice = await ctx.ui.select(title, [...options]);
  return options.find(option => option === choice);
}

const chooseBudget: Chooser<number> = ctx =>
  wholeNumberInput(ctx, 'Budget in units for the complete packet', 'for example 150000', 'The budget is a whole number of units, at least 1.');
const chooseMode: Chooser<EnhancementMode> = ctx => pick(ctx, 'Enhancement mode', enhancementModes);
const chooseClarification: Chooser<Clarification> = async ctx => {
  const choice = await pick(ctx, 'Clarification questions from discovery (applied only in sessions with a UI)',
    ['on', 'on, with a question timeout', 'off']);
  if (choice !== 'on, with a question timeout') return choice === undefined ? undefined : { enabled: choice === 'on' };
  const seconds = await wholeNumberInput(ctx, 'Question timeout in seconds', 'for example 300', 'The timeout is a whole number of seconds, at least 1.');
  return seconds === undefined ? undefined : { enabled: true, questionTimeoutSeconds: seconds };
};
const chooseModel: Chooser<string> = async (ctx, config) => {
  const discovery = config?.discovery;
  if (!discovery) {
    ctx.ui.notify('The discovery models come from `mipmux config`, which is unavailable or has discovery off.', 'error');
    return undefined;
  }
  return pick(ctx, 'Discovery model (the server allows these; add others to discovery.allowedModels)',
    [...new Set([discovery.model, ...discovery.allowedModels])]);
};
const chooseThinking: Chooser<ThinkingLevel> = ctx =>
  pick(ctx, 'Thinking level (the server reports at build time whether the model supports it)', thinkingLevels);

/** The actions that set, pin, unpin or clear one preference in its holder, stored through `store`. */
function preferenceActions<T>(menu: Menu, scope: string, current: Preference<T> | undefined, choose: () => Promise<T | undefined>,
  store: (preference: Preference<T> | null) => Promise<void>): void {
  menu.set(`set for ${scope}`, async () => {
    const value = await choose();
    if (value !== undefined) await store({ value, pinned: current?.pinned ?? false });
  });
  if (!current) return;
  menu.set(`${current.pinned ? 'unpin' : 'pin'} the value for ${scope}`, async () => { await store({ ...current, pinned: !current.pinned }); });
  menu.set(`clear the value for ${scope}`, async () => { await store(null); });
}

/** Edits one setting in the session and, when `saved` is given, in the selected saved workspace. */
async function editSetting<T>(ctx: MipmuxContext, host: PanelHost, title: string, choose: Chooser<T>, session: Field<Preferences, T>,
  saved: { readonly workspace: SavedWorkspace; readonly field: Field<SavedWorkspace, T> } | null, config: MipmuxConfig | null): Promise<void> {
  const menu: Menu = new Map(), state = host.state();
  preferenceActions(menu, 'this session', session.get(state.preferences), () => choose(ctx, config),
    preference => host.record({ ...state, preferences: session.set(state.preferences, preference) }, ctx));
  if (saved) {
    const { workspace, field } = saved;
    preferenceActions(menu, `the saved workspace "${workspace.name}"`, field.get(workspace), () => choose(ctx, config),
      async preference => { await saveWorkspaces(ctx, host, entries => entries.map(entry => entry.name === workspace.name ? field.set(entry, preference) : entry)); });
  }
  await run(ctx, title, menu.set('back', done));
}

async function absolutePath(ctx: MipmuxContext, title: string): Promise<string | undefined> {
  const path = (await ctx.ui.input(title, '/absolute/path'))?.trim();
  if (path && !isAbsolute(path)) { ctx.ui.notify('Use an absolute path.', 'error'); return undefined; }
  return path || undefined;
}

function rootName(path: string): string {
  const name = basename(path).replace(/[^A-Za-z0-9_-]/g, '-');
  return rootNamePattern.test(name) ? name : `root-${name}`;
}

async function addRoot(ctx: MipmuxContext, roots: Workspace['roots']): Promise<void> {
  const path = await absolutePath(ctx, 'Root folder');
  if (!path) return;
  if (!(await stat(path).then(info => info.isDirectory(), () => false))) { ctx.ui.notify(`${path} is not a folder.`, 'error'); return; }
  const proposed = rootName(path), name = (await ctx.ui.input(`Root name (empty for ${proposed})`, proposed))?.trim() || proposed;
  if (!rootNamePattern.test(name) || roots.some(root => root.name === name)) {
    ctx.ui.notify('A root name starts with a letter, uses letters, digits, _ and -, and differs from the other roots.', 'error');
    return;
  }
  roots.push({ name, absolutePath: path });
}

/** Edits the roots in place; returns false when the user cancels the form. */
async function editRoots(ctx: MipmuxContext, roots: Workspace['roots']): Promise<boolean> {
  for (;;) {
    const menu: Menu = new Map([['add a root', () => addRoot(ctx, roots)]]);
    if (roots.length) {
      menu.set('remove a root', async () => {
        const name = await pick(ctx, 'Remove which root?', roots.map(root => root.name));
        if (name !== undefined) roots.splice(roots.findIndex(root => root.name === name), 1);
      });
      menu.set('continue', done);
    }
    const listing = roots.map(root => `  ${root.name}  ${root.absolutePath}`).join('\n') || '  none';
    const choice = await run(ctx, `Roots\n${listing}`, menu.set('cancel', done));
    if (choice === undefined || choice === 'cancel') return false;
    if (choice === 'continue') return true;
  }
}

function exclusionLabel(exclusion: Workspace['exclusions'][number]): string {
  return `${exclusion.root}: ${exclusion.kind === 'prefix' ? exclusion.path : exclusion.pattern}`;
}

async function addExclusion(ctx: MipmuxContext, roots: Workspace['roots'], exclusions: Workspace['exclusions']): Promise<void> {
  const root = await pick(ctx, 'Exclude under which root?', roots.map(entry => entry.name));
  const kind = root && await pick(ctx, 'Exclusion kind', ['path prefix', 'glob pattern']);
  const text = kind && (await ctx.ui.input(kind === 'path prefix' ? 'Path relative to the root' : 'Glob pattern'))?.trim();
  if (!root || !text) return;
  exclusions.push(kind === 'path prefix' ? { kind: 'prefix', root, path: text } : { kind: 'glob', root, pattern: text });
}

/** Edits the exclusions in place; returns false when the user cancels the form. */
async function editExclusions(ctx: MipmuxContext, roots: Workspace['roots'], exclusions: Workspace['exclusions']): Promise<boolean> {
  for (;;) {
    const menu: Menu = new Map([['add an exclusion', () => addExclusion(ctx, roots, exclusions)]]);
    if (exclusions.length) menu.set('remove an exclusion', async () => {
      const labels = exclusions.map(exclusionLabel), choice = await pick(ctx, 'Remove which exclusion?', labels);
      if (choice !== undefined) exclusions.splice(labels.indexOf(choice), 1);
    });
    const listing = exclusions.map(item => `  ${exclusionLabel(item)}`).join('\n') || '  none';
    const choice = await run(ctx, `Exclusions\n${listing}`, menu.set('continue', done));
    if (choice === undefined) return false;
    if (choice === 'continue') return true;
  }
}

async function chooseOutput(ctx: MipmuxContext, proposed: string): Promise<string | undefined> {
  const choice = await pick(ctx, 'Output folder for packets (never indexed)', [proposed, 'another folder']);
  return choice === 'another folder' ? absolutePath(ctx, 'Output folder') : choice;
}

/** Edits roots, output folder, exclusions and name, starting from `start`; returns null when the user cancels. */
async function workspaceForm(ctx: MipmuxContext, start: Workspace, startName: string | null, taken: ReadonlySet<string>): Promise<SavedWorkspace | null> {
  const roots = [...start.roots], exclusions = [...start.exclusions];
  if (!(await editRoots(ctx, roots))) return null;
  const outputRoot = await chooseOutput(ctx, start.outputRoot);
  if (!outputRoot || !(await editExclusions(ctx, roots, exclusions))) return null;
  const proposed = startName ?? roots[0]?.name ?? 'workspace';
  const name = (await ctx.ui.input(`Name for this saved workspace (empty for ${proposed})`, proposed))?.trim() || proposed;
  if (taken.has(name)) { ctx.ui.notify(`A saved workspace is already named "${name}".`, 'error'); return null; }
  const summary = [name, ...roots.map(root => `  ${root.name}  ${root.absolutePath}`), `  output ${outputRoot}`,
    `  ${count(exclusions.length, 'exclusion')}`].join('\n');
  if (!(await ctx.ui.confirm('Save this workspace?', summary))) return null;
  await mkdir(outputRoot, { recursive: true });
  return { name, roots, outputRoot, exclusions };
}

/** The Git repository root containing `cwd`, or `cwd` itself outside a repository. */
async function proposedRoot(cwd: string): Promise<string> {
  return promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd }).then(result => result.stdout.trim(), () => cwd);
}

/** Saves a new workspace and selects it, or the earlier duplicate it merged into. */
async function saveCreated(ctx: MipmuxContext, host: PanelHost, created: SavedWorkspace | null): Promise<void> {
  if (!created) return;
  const survivor = (await saveWorkspaces(ctx, host, entries => [...entries, created])).find(entry => duplicateKey(entry) === duplicateKey(created));
  if (survivor) await host.record({ ...host.state(), selected: survivor.name }, ctx);
}

/** An edit replaces the entry, keeps its discovery preferences, and follows a rename in this session. */
async function saveEdited(ctx: MipmuxContext, host: PanelHost, previous: SavedWorkspace, edited: SavedWorkspace | null): Promise<void> {
  if (!edited) return;
  const merged: SavedWorkspace = { ...edited };
  if (previous.model) merged.model = previous.model;
  if (previous.thinking) merged.thinking = previous.thinking;
  await saveWorkspaces(ctx, host, workspaces => workspaces.map(entry => entry.name === previous.name ? merged : entry));
  if (host.state().selected === previous.name) await host.record({ ...host.state(), selected: edited.name }, ctx);
}

async function workspaceMenu(ctx: MipmuxContext, host: PanelHost, saved: readonly SavedWorkspace[], selection: Selection): Promise<void> {
  const state = host.state(), names = new Set(saved.map(entry => entry.name)), menu: Menu = new Map();
  const select = (name: string | undefined) => name === undefined ? Promise.resolve() : host.record({ ...host.state(), selected: name }, ctx);
  if (saved.length) menu.set('select a saved workspace', async () => select(await pick(ctx, 'Select a saved workspace', [...names])));
  menu.set('create a saved workspace', async () => {
    const root = await proposedRoot(ctx.cwd);
    await saveCreated(ctx, host, await workspaceForm(ctx, { roots: [{ name: rootName(root), absolutePath: root }],
      outputRoot: `${root}/prompt-exports`, exclusions: [] }, null, names));
  });
  if (selection.kind === 'found') {
    const current = selection.workspace, others = new Set([...names].filter(name => name !== current.name));
    menu.set(`edit "${current.name}"`, async () => saveEdited(ctx, host, current, await workspaceForm(ctx, current, current.name, others)));
    menu.set(`delete "${current.name}"`, async () => {
      if (!(await ctx.ui.confirm(`Delete "${current.name}"?`, 'Sessions that selected it block mipmux calls until they select again.'))) return;
      await saveWorkspaces(ctx, host, workspaces => workspaces.filter(entry => entry.name !== current.name));
      await host.record({ ...host.state(), selected: null }, ctx);
    });
  }
  const declared = state.lastDeclared;
  if (declared) menu.set('save the workspace the agent last used', async () => saveCreated(ctx, host, await workspaceForm(ctx, declared, null, names)));
  if (state.selected !== null) menu.set('clear the selection', () => host.record({ ...host.state(), selected: null }, ctx));
  await run(ctx, workspaceLine(selection), menu.set('back', done));
}

async function loadSelection(host: PanelHost): Promise<{ saved: SavedWorkspace[]; selection: Selection }> {
  const name = host.state().selected;
  let saved: SavedWorkspace[];
  try { saved = await readStore(host.storePath); }
  catch (error) {
    if (!(error instanceof StoreError) || name === null) throw error;
    return { saved: [], selection: { kind: 'unreadable', name, message: error.message } };
  }
  const workspace = saved.find(entry => entry.name === name);
  const selection: Selection = name === null ? { kind: 'none' } : workspace ? { kind: 'found', workspace }
    : { kind: 'missing', name, saved: saved.map(entry => entry.name) };
  return { saved, selection };
}

/** Opens the panel until the user closes it. */
export async function openPanel(ctx: MipmuxContext, host: PanelHost): Promise<void> {
  const config = await host.readConfig().then(value => ({ value, error: null }),
    error => ({ value: null, error: error instanceof Error ? error.message : String(error) }));
  const defaults = config.value ? `Server defaults come from ${config.value.path}; mipmux reads them when it starts, so after editing the ` +
    'file run /mcp-adapter reconnect mipmux.' : `Server defaults are unavailable: ${config.error}`;
  for (;;) {
    const { saved, selection } = await loadSelection(host);
    const workspace = selection.kind === 'found' ? selection.workspace : null;
    const header = [workspace ? `mipmux workspace "${workspace.name}": ${count(workspace.roots.length, 'root')}, output ${workspace.outputRoot}, ` +
      count(workspace.exclusions.length, 'exclusion') : `mipmux ${workspaceLine(selection)}`, defaults,
    'An unpinned value applies when the agent sends none; a pinned value replaces the agent\'s.'].join('\n');
    const lines = settingLines(host.state(), workspace, config.value);
    const savedField = <T>(field: Field<SavedWorkspace, T>) => workspace && { workspace, field };
    const menu: Menu = new Map([
      [workspaceLine(selection), () => workspaceMenu(ctx, host, saved, selection)],
      [lines.budgetUnits, () => editSetting(ctx, host, lines.budgetUnits, chooseBudget, sessionFields.budgetUnits, null, config.value)],
      [lines.enhancementMode, () => editSetting(ctx, host, lines.enhancementMode, chooseMode, sessionFields.enhancementMode, null, config.value)],
      [lines.clarification, () => editSetting(ctx, host, lines.clarification, chooseClarification, sessionFields.clarification, null, config.value)],
      [lines.model, () => editSetting(ctx, host, lines.model, chooseModel, sessionFields.model, savedField(workspaceModel), config.value)],
      [lines.thinking, () => editSetting(ctx, host, lines.thinking, chooseThinking, sessionFields.thinking, savedField(workspaceThinking), config.value)],
    ]);
    const choice = await run(ctx, header, menu.set('close', done));
    if (choice === undefined || choice === 'close') return;
  }
}
