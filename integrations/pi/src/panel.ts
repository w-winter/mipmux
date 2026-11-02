import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager } from '@earendil-works/pi-tui';
import type { MipmuxCommands, MipmuxConfig } from './config.ts';
import { addRoot, addWorkspace, applyDraft, createFromFolder, deleteWorkspace, editSelected, openDraft, removeRoot,
  renameSelected, selectedWorkspace, type Draft } from './draft.ts';
import { entryRule, ignoreFileName, ignoreFilePath, isRule, readIgnoreFile, typedRule, writeIgnoreFile, type IgnoreFile } from './ignore-file.ts';
import { abbreviate, expand, resolveExisting, type PathBase } from './paths.ts';
import { FilterListScreen, ListScreen, PathScreen, PromptScreen, type ListRow, type PanelControl, type PanelTheme, type Screen } from './screens.ts';
import { serverDefaults, writeServerDefaults, type DiscoveryDefaults, type ServerDefaults } from './server-config.ts';
import { readStore, StoreError, updateStore, type Store } from './store.ts';
import { duplicateKey, type Clarification, type EnhancementMode, type Merge, type Preference, type Preferences, type SavedWorkspace,
  type SessionState, type ThinkingLevel, type Workspace } from './state.ts';

/*
 * The /mipmux panel: one list of settings, where enter edits the highlighted value in place, `p` pins it and delete clears
 * it. Every change stays in a draft until ctrl+s saves it; escape closes the panel and discards what was not saved.
 */
export interface PanelHost {
  readonly storePath: string;
  readonly home: string;
  state(): SessionState;
  record(state: SessionState): Promise<void>;
  readonly mipmux: MipmuxCommands;
}
/** mipmux's configuration as `mipmux config` reported it, with the file's text, or why it could not be read. */
type ServerConfig = { readonly kind: 'read'; readonly report: MipmuxConfig; readonly text: string } |
  { readonly kind: 'unavailable'; readonly problem: string };
/** The parts of Pi's context the panel uses; `custom` shows the panel until it calls `done`. */
export interface PanelContext {
  readonly cwd: string;
  readonly ui: {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
    custom(factory: (tui: { requestRender(): void }, theme: PanelTheme, keybindings: KeybindingsManager, done: () => void) => PanelComponent): Promise<void>;
  };
}
/** What the panel shows and edits, and how it reports back to Pi. */
interface PanelOptions {
  readonly ctx: PanelContext;
  readonly host: PanelHost;
  readonly saved: Store;
  readonly config: ServerConfig;
  /** Where a new workspace's folder picker starts. */
  readonly proposed: string;
  readonly tui: { requestRender(): void };
  readonly theme: PanelTheme;
  readonly keybindings: KeybindingsManager;
  readonly done: () => void;
}
type Setting = keyof Preferences;
type Value<K extends Setting> = NonNullable<Preferences[K]>['value'];
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
const thinkingLevels: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const enhancementModes: { readonly value: EnhancementMode; readonly description: string }[] = [
  { value: 'augment', description: 'Keeps the task as written and adds what discovery found.' },
  { value: 'fullRewrite', description: 'Rewrites the task into a complete prompt.' },
  { value: 'preserve', description: 'Keeps the task exactly as written.' },
];
const units = (value: number) => `${value.toLocaleString('en-US')} units`;

/** A budget typed as a whole number, with an optional k for thousands; null when the text is not one. */
function parseBudget(text: string): number | null {
  const match = /^(\d[\d,_]*)(k?)$/i.exec(text), value = match ? Number(match[1]?.replace(/[,_]/g, '')) * (match[2] ? 1000 : 1) : 0;
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

async function readServerConfig(mipmux: MipmuxCommands): Promise<ServerConfig> {
  try {
    const report = await mipmux.config();
    return { kind: 'read', report, text: await readFile(report.path, 'utf8') };
  } catch (error) {
    return { kind: 'unavailable', problem: error instanceof Error ? error.message : String(error) };
  }
}

function formatClarification(value: Clarification): string {
  if (!value.enabled) return 'off';
  return value.questionTimeoutSeconds === undefined ? 'on' : `on, ${value.questionTimeoutSeconds} s question timeout`;
}

function mergeNotes(merges: readonly Merge[]): string[] {
  return merges.map(merge => `Merged duplicates into "${merge.survivor}", removing ${merge.removed.map(entry => `"${entry.name}"`).join(', ')}.`);
}

/** The panel component: a stack of screens over one draft. Keys are handled one at a time, in order. */
export class PanelComponent implements Component, Focusable {
  private readonly stack: Screen[] = [];
  private queue: Promise<void> = Promise.resolve();
  private message: { readonly text: string; readonly kind: 'info' | 'error' } | null = null;
  private closed = false;
  private hasFocus = false;
  private snapshot: Store;
  private baseline: Draft;
  private draft: Draft;
  private readonly control: PanelControl;
  /** Each root's `.mipmux_ignore` as the panel first read it, or as it last saved it. */
  private readonly ignoreReads = new Map<string, IgnoreFile>();
  private readonly ctx: PanelContext;
  private readonly host: PanelHost;
  private config: ServerConfig;
  /** The models mipmux has credentials for, once `mipmux models` reported them. */
  private models: readonly string[] | null = null;
  private readonly proposed: string;
  private readonly tui: PanelOptions['tui'];
  private readonly done: () => void;

  constructor({ ctx, host, saved, config, proposed, tui, theme, keybindings, done }: PanelOptions) {
    this.ctx = ctx;
    this.host = host;
    this.config = config;
    this.proposed = proposed;
    this.tui = tui;
    this.done = done;
    this.snapshot = saved;
    this.baseline = this.draft = openDraft(saved, host.state(), config.kind === 'read' ? serverDefaults(config.report) : null);
    this.control = { theme, keybindings, push: screen => this.push(screen), pop: () => { this.stack.pop(); this.refocus(); },
      say: (text, kind) => { this.message = { text, kind }; } };
    this.push(new ListScreen('settings', this.control, 'change', () => this.mainRows()));
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.refocus(); }
  private refocus(): void { for (const [index, screen] of this.stack.entries()) screen.focused = this.hasFocus && index === this.stack.length - 1; }
  private push(screen: Screen): void { this.stack.push(screen); this.refocus(); }
  private top(): Screen { return this.stack[this.stack.length - 1] ?? this.fail('the panel has no screen'); }
  private fail(problem: string): never { throw new Error(problem); }
  private dirty(): boolean { return JSON.stringify(this.draft) !== JSON.stringify(this.baseline); }
  private change(next: Draft): void { this.draft = next; }
  private get base(): PathBase { return { base: this.ctx.cwd, home: this.host.home }; }
  private show(path: string): string { return abbreviate(path, this.host.home); }

  invalidate(): void {}

  render(width: number): string[] {
    const { theme } = this.control, screen = this.top(), nested = this.stack.length > 1;
    const config = this.config.kind === 'read' ? `Server defaults come from ${this.show(this.config.report.path)}.`
      : `Server defaults are unavailable: ${this.config.problem}`;
    const header = nested ? [] : [theme.fg('muted', 'Saved changes apply to the agent\'s next mipmux call.'), theme.fg('muted', config)];
    const message = this.message ? wrapTextWithAnsi(this.message.text, width).map(line => theme.fg(this.message?.kind === 'error' ? 'error' : 'success', line)) : [];
    const hints = `${screen.hints()} · ctrl+s save · esc ${nested ? 'back' : this.dirty() ? 'discard and close' : 'close'}`;
    const footer = wrapTextWithAnsi(theme.fg('dim', hints) + (this.dirty() ? theme.fg('warning', ' (unsaved)') : ''), width);
    const border = theme.fg('border', '─'.repeat(width));
    return [border, theme.fg('accent', theme.bold(nested ? `mipmux › ${screen.title}` : 'mipmux')), ...header, ...screen.render(width), '',
      ...message, ...footer, border].map(line => truncateToWidth(line, width));
  }

  /** Queues `data` behind the keys before it; the returned promise settles once this key took effect. */
  handleInput(data: string): Promise<void> {
    this.queue = this.queue.then(() => this.process(data));
    return this.queue;
  }

  private async process(data: string): Promise<void> {
    if (this.closed) return;
    this.message = null;
    const { keybindings } = this.control;
    try {
      if (matchesKey(data, Key.ctrl('s'))) await this.save();
      else if (keybindings.matches(data, 'tui.select.cancel')) this.back();
      else await this.top().handleInput(data);
    } catch (error) {
      this.control.say(error instanceof Error ? error.message : String(error), 'error');
    }
    this.tui.requestRender();
  }

  private back(): void {
    if (this.stack.length > 1) { this.control.pop(); return; }
    if (this.dirty()) this.ctx.ui.notify('mipmux: unsaved changes discarded.', 'info');
    this.closed = true;
    this.done();
  }

  private async save(): Promise<void> {
    if (!this.dirty()) { this.control.say('Nothing to save.', 'info'); return; }
    const draft = this.draft, snapshot = this.snapshot, before = this.baseline.server;
    if (this.config.kind === 'read' && before && draft.server && JSON.stringify(draft.server) !== JSON.stringify(before)) {
      await writeServerDefaults(this.config.report.path, this.config.text, before, draft.server, async path => { await this.host.mipmux.config(path); });
    }
    for (const edit of draft.ignoreEdits) {
      const read = this.ignoreReads.get(edit.root);
      if (read?.kind !== 'read') throw new Error(`${ignoreFilePath(edit.root)} could not be read, so it was not changed.`);
      await writeIgnoreFile(edit.root, read.lines, edit.lines);
      this.ignoreReads.set(edit.root, { kind: 'read', lines: edit.lines });
    }
    const changed = draft.entries.filter(entry => !snapshot.workspaces.some(saved => JSON.stringify(saved) === JSON.stringify(entry.workspace)));
    for (const entry of changed) await mkdir(entry.workspace.outputRoot, { recursive: true });
    // As with workspaces, the footer setting changes only when this panel changed it, so another session's change survives.
    const result = await updateStore(this.host.storePath, stored => ({ workspaces: applyDraft(stored.workspaces, draft, snapshot.workspaces),
      showInFooter: draft.showInFooter === snapshot.showInFooter ? stored.showInFooter : draft.showInFooter }));
    const merge = result.merges.find(item => item.removed.some(removed => removed.name === draft.selected));
    await this.host.record({ selected: merge?.survivor ?? draft.selected, preferences: draft.preferences, lastDeclared: this.host.state().lastDeclared });
    this.snapshot = result;
    this.config = await readServerConfig(this.host.mipmux);
    this.baseline = this.draft = openDraft(result, this.host.state(), this.config.kind === 'read' ? serverDefaults(this.config.report) : null);
    this.control.say(['Saved. The agent\'s next mipmux call uses these settings.', ...mergeNotes(result.merges)].join(' '), 'info');
  }

  private mainRows(): ListRow[] {
    const draft = this.draft, workspace = selectedWorkspace(draft);
    const missing = draft.selected !== null && !workspace;
    const rows: ListRow[] = [{ id: 'workspace', section: 'Workspace', label: 'Selected workspace', inherited: !workspace,
      value: workspace?.name ?? (missing ? `${draft.selected} (no longer saved)` : 'none, so the agent chooses'),
      description: 'The folders this session\'s builds use. Enter selects or creates a saved workspace; del clears the selection.',
      activate: () => this.push(this.workspaceList()),
      remove: draft.selected === null ? undefined : { label: 'clear the selection', run: () => this.change({ ...draft, selected: null }) } },
    { id: 'roots', label: 'Roots', inherited: !workspace, value: workspace ? workspace.roots.map(root => this.show(root.absolutePath)).join(', ') : 'none',
      description: workspace ? 'The folders mipmux indexes. Enter adds or removes folders.'
        : 'Enter chooses a folder and creates a saved workspace named after it.',
      activate: () => this.push(workspace ? this.folderList(workspace) : this.newWorkspacePicker()) }];
    if (workspace) rows.push(...this.workspaceRows(workspace));
    return [...rows, ...this.sessionRows(workspace), ...this.serverRows(), {
      id: 'footer', section: 'Display', label: 'Show in footer', value: draft.showInFooter ? 'on' : 'off',
      description: `Shows "mipmux: <workspace>" in the footer of every session. Saved to ${this.show(this.host.storePath)}; enter turns it on or off.`,
      activate: () => this.change({ ...this.draft, showInFooter: !this.draft.showInFooter }) }];
  }

  private workspaceRows(workspace: SavedWorkspace): ListRow[] {
    const discovery = this.draft.server?.discovery;
    return [{ id: 'output', label: 'Output folder', value: this.show(workspace.outputRoot),
      description: 'Where mipmux writes packets. mipmux never indexes it, and saving creates it if it is missing.',
      activate: () => this.push(this.outputPicker(workspace)) },
    { id: 'ignore', label: 'Ignore rules', inherited: this.ignoreSummary(workspace) === 'none', value: this.ignoreSummary(workspace),
      description: `Lines in each root's ${ignoreFileName}, in gitignore syntax: a plain line leaves paths out, and a line starting with ! ` +
        'brings back a path another ignore file hides. They apply to every workspace and client that uses the folder.',
      activate: () => this.push(this.ignoreList()) },
    { id: 'rename', label: 'Rename workspace', description: 'A new workspace is named after its first folder; renaming it is optional.',
      activate: () => this.push(new PromptScreen('rename', this.control, workspace.name, 'Sessions that selected the old name select again.', text => {
        const renamed = renameSelected(this.draft, text);
        if ('problem' in renamed) return renamed.problem;
        this.change(renamed);
        return null;
      })) },
    this.preferenceRow('workspace.model', 'Discovery model', this.serverDefault(discovery?.model), this.workspaceField(workspaceModel), String,
      apply => this.chooseModel(workspace.model?.value, apply), 'Saved with this workspace for every session that selects it.'),
    this.preferenceRow('workspace.thinking', 'Thinking level', this.serverDefault(discovery?.thinking), this.workspaceField(workspaceThinking), String,
      apply => this.chooseThinking(workspace.thinking?.value, apply), 'Saved with this workspace for every session that selects it.')];
  }

  private sessionRows(workspace: SavedWorkspace | null): ListRow[] {
    const server = this.draft.server, discovery = server?.discovery;
    const fromWorkspace = <T>(preference: Preference<T> | undefined, serverValue: string) =>
      preference ? `from the workspace: ${String(preference.value)}` : serverValue;
    const scope = 'This session only; it takes precedence over the saved workspace.';
    const budget = this.preferenceRow('budgetUnits', 'Budget', this.serverDefault(server && units(server.contextBudgetUnits)),
      this.sessionField(sessionFields.budgetUnits), units, apply => this.push(this.budgetPrompt(
        this.draft.preferences.budgetUnits ? String(this.draft.preferences.budgetUnits.value) : '',
        'Units for the complete packet, such as 150000 or 150k. A pinned budget also applies to preparations.', apply)),
      'The packet size for builds, in mipmux\'s estimated units.');
    return [{ ...budget, section: 'This session' },
      this.preferenceRow('enhancementMode', 'Enhancement mode', this.serverDefault(server?.defaultEnhancementMode),
        this.sessionField(sessionFields.enhancementMode), String, apply => this.choose('enhancement mode',
          enhancementModes.map(mode => ({ id: mode.value, label: mode.value, description: mode.description, choose: () => apply(mode.value) })),
          this.draft.preferences.enhancementMode?.value), 'How discovery treats the task text.'),
      this.preferenceRow('clarification', 'Clarification', 'off', this.sessionField(sessionFields.clarification), formatClarification,
        apply => this.chooseClarification(apply), 'Lets discovery ask you questions in a form; it applies only in sessions with a UI.'),
      this.preferenceRow('model', 'Discovery model', fromWorkspace(workspace?.model, this.serverDefault(discovery?.model)),
        this.sessionField(sessionFields.model), String, apply => this.chooseModel(this.draft.preferences.model?.value, apply), scope),
      this.preferenceRow('thinking', 'Thinking level', fromWorkspace(workspace?.thinking, this.serverDefault(discovery?.thinking)),
        this.sessionField(sessionFields.thinking), String, apply => this.chooseThinking(this.draft.preferences.thinking?.value, apply), scope)];
  }

  private serverDefault(value: string | null | undefined): string {
    if (this.draft.server && this.draft.server.discovery === null && value === undefined) return 'discovery not configured';
    return value ? `server default: ${value}` : 'server default';
  }

  private budgetPrompt(start: string, help: string, apply: (value: number) => void): PromptScreen {
    return new PromptScreen('budget', this.control, start, help, text => {
      const value = parseBudget(text);
      if (value === null) return 'Type a whole number of units, such as 150000 or 150k.';
      apply(value);
      return null;
    });
  }

  private editServer(change: (server: ServerDefaults) => ServerDefaults): void {
    const server = this.draft.server;
    if (server) this.change({ ...this.draft, server: change(server) });
  }

  private editDiscovery(change: (discovery: DiscoveryDefaults) => DiscoveryDefaults): void {
    this.editServer(server => server.discovery ? { ...server, discovery: change(server.discovery) } : server);
  }

  /** The request defaults in mipmux's configuration file, which every client's builds use and a running mipmux rereads. */
  private serverRows(): ListRow[] {
    const server = this.draft.server;
    if (!server || this.config.kind !== 'read') return [];
    const scope = `Saved to ${this.show(this.config.report.path)} for every client; a running mipmux applies it at its next build.`;
    const rows: ListRow[] = [{ id: 'server.budget', section: 'Server defaults (all clients)', label: 'Budget', value: units(server.contextBudgetUnits),
      description: `The budget of every build that names none. ${scope}`,
      activate: () => this.push(this.budgetPrompt(String(server.contextBudgetUnits), 'Units for every build that names no budget, such as 150000 or 150k.',
        value => this.editServer(edited => ({ ...edited, contextBudgetUnits: value })))) },
    { id: 'server.mode', label: 'Enhancement mode', value: server.defaultEnhancementMode, description: scope,
      activate: () => this.choose('enhancement mode', enhancementModes.map(mode => ({ id: mode.value, label: mode.value, description: mode.description,
        choose: () => this.editServer(edited => ({ ...edited, defaultEnhancementMode: mode.value })) })), server.defaultEnhancementMode) }];
    const discovery = server.discovery;
    if (!discovery) return rows;
    return [...rows,
      { id: 'server.model', label: 'Discovery model', value: discovery.model, description: `The model of every build that names none. ${scope}`,
        activate: () => this.pickDefaultModel() },
      { id: 'server.thinking', label: 'Thinking level', value: discovery.thinking, description: scope,
        activate: () => this.chooseThinking(discovery.thinking, level => this.editDiscovery(edited => ({ ...edited, thinking: level }))) },
      { id: 'server.allowed', label: 'Allowed models', inherited: !discovery.allowedModels.length,
        value: discovery.allowedModels.join(', ') || 'only the discovery model',
        description: `The models a session or saved workspace may choose besides the discovery model. ${scope}`, activate: () => this.pickAllowedModels() }];
  }

  /** The models mipmux has credentials for, read with `mipmux models` the first time the panel needs them. */
  private async availableModels(): Promise<readonly string[]> {
    if (this.config.kind !== 'read') throw new Error(`Server defaults are unavailable: ${this.config.problem}`);
    const listed = this.models ?? await this.host.mipmux.models(this.config.report.path);
    if (!listed.length) throw new Error(`mipmux has credentials for no discovery model. It reads them from discovery.authPath in ${this.config.report.path}, ` +
      'or from auth.json in Pi\'s agent folder when that is unset; sign in with Pi\'s /login.');
    this.models = listed;
    return listed;
  }

  private async pickDefaultModel(): Promise<void> {
    const models = await this.availableModels();
    this.push(new FilterListScreen('discovery model', this.control, 'choose', () => models.map(model => ({ id: model, label: model,
      description: 'Models mipmux has credentials for, from mipmux models.', activate: () => {
        this.editDiscovery(edited => ({ ...edited, model }));
        this.control.pop();
      } }))));
  }

  private async pickAllowedModels(): Promise<void> {
    const models = await this.availableModels();
    this.push(new FilterListScreen('allowed models', this.control, 'allow or disallow', () => {
      const discovery = this.draft.server?.discovery;
      if (!discovery) return [];
      return [...new Set([...models, ...discovery.allowedModels])].sort().filter(model => model !== discovery.model).map(model => ({
        id: model, label: model, value: discovery.allowedModels.includes(model) ? `allowed${models.includes(model) ? '' : ', no credentials'}` : '',
        description: 'Enter allows or disallows the model; Esc returns.',
        activate: () => this.editDiscovery(edited => ({ ...edited, allowedModels: edited.allowedModels.includes(model)
          ? edited.allowedModels.filter(allowed => allowed !== model) : [...edited.allowedModels, model] })) }));
    }));
  }

  private sessionField<T>(field: Field<Preferences, T>): Field<Draft, T> {
    return { get: draft => field.get(draft.preferences), set: (draft, preference) => ({ ...draft, preferences: field.set(draft.preferences, preference) }) };
  }

  private workspaceField<T>(field: Field<SavedWorkspace, T>): Field<Draft, T> {
    return { get: draft => { const workspace = selectedWorkspace(draft); return workspace ? field.get(workspace) : undefined; },
      set: (draft, preference) => editSelected(draft, workspace => field.set(workspace, preference)) };
  }

  /** A setting row: enter edits the value, `p` pins or unpins it and delete clears it, all in the draft. */
  private preferenceRow<T>(id: string, label: string, inherited: string, field: Field<Draft, T>, format: (value: T) => string,
    edit: (apply: (value: T) => void) => void, description: string): ListRow {
    const current = field.get(this.draft);
    const set = (preference: Preference<T> | null) => this.change(field.set(this.draft, preference));
    return { id, label, description: `${description} Pin a value to override the agent's value too.`, inherited: !current,
      value: current ? `${format(current.value)}${current.pinned ? ' · pinned' : ''}` : inherited,
      activate: () => edit(value => set({ value, pinned: field.get(this.draft)?.pinned ?? false })),
      pin: current && (() => set({ ...current, pinned: !current.pinned })), remove: current && { label: 'clear', run: () => set(null) } };
  }

  /** A list of choices; enter applies the highlighted one and returns. */
  private choose(title: string, options: readonly { readonly id: string; readonly label: string; readonly description?: string; choose(): void }[],
    current: string | undefined): void {
    const screen = new ListScreen(title, this.control, 'choose', () => options.map(option => ({ ...option,
      activate: () => { this.control.pop(); option.choose(); } })));
    this.push(current === undefined ? screen : screen.select(current));
  }

  private chooseModel(current: string | undefined, apply: (value: string) => void): void {
    if (this.config.kind !== 'read') { this.control.say(`Server defaults are unavailable: ${this.config.problem}`, 'error'); return; }
    const discovery = this.draft.server?.discovery;
    if (!discovery) { this.control.say(`Discovery is not configured in ${this.config.report.path}.`, 'error'); return; }
    const help = 'To offer another model, allow it under Server defaults, Allowed models.';
    this.choose('discovery model', [...new Set([discovery.model, ...discovery.allowedModels])].map(model => ({ id: model, label: model,
      description: help, choose: () => apply(model) })), current);
  }

  private chooseThinking(current: ThinkingLevel | undefined, apply: (value: ThinkingLevel) => void): void {
    this.choose('thinking level', thinkingLevels.map(level => ({ id: level, label: level,
      description: 'mipmux fails a build whose model does not support the level, and names the levels it does.', choose: () => apply(level) })), current);
  }

  private chooseClarification(apply: (value: Clarification) => void): void {
    this.choose('clarification', [{ id: 'on', label: 'on', choose: () => apply({ enabled: true }) },
      { id: 'timeout', label: 'on, with a question timeout', choose: () => this.push(new PromptScreen('question timeout', this.control, '',
        'Seconds to wait for each answer.', text => {
          if (!/^[1-9]\d*$/.test(text)) return 'Type a whole number of seconds.';
          apply({ enabled: true, questionTimeoutSeconds: Number(text) });
          return null;
        })) },
      { id: 'off', label: 'off', choose: () => apply({ enabled: false }) }], undefined);
  }

  private workspaceList(): ListScreen {
    const declared = this.host.state().lastDeclared;
    const rows = (): ListRow[] => {
      const draft = this.draft, select = (selected: string | null) => () => { this.change({ ...this.draft, selected }); this.control.pop(); };
      const unsaved = declared && !draft.entries.some(entry => duplicateKey(entry.workspace) === duplicateKey(declared));
      return [...draft.entries.map(({ workspace }) => ({ id: `saved:${workspace.name}`, label: workspace.name + (workspace.name === draft.selected ? ' ✓' : ''),
        value: workspace.roots.map(root => this.show(root.absolutePath)).join(', '), activate: select(workspace.name),
        description: 'Enter selects it for this session; del deletes it from your saved workspaces.',
        remove: { label: 'delete', run: () => this.change(deleteWorkspace(this.draft, workspace.name)) } })),
      { id: 'new', label: '+ New workspace from a folder', activate: () => { this.control.pop(); this.push(this.newWorkspacePicker()); } },
      ...(unsaved ? [{ id: 'declared', label: '+ The workspace the agent last used', value: declared.roots.map(root => this.show(root.absolutePath)).join(', '),
        description: declared.exclusions.length ? 'Saves its folders and output folder; the exclusions the agent sent are not kept, so use ' +
          'Ignore rules instead.' : 'Saves its folders and output folder.',
        activate: () => { this.change(addWorkspace(this.draft, declared)); this.control.pop(); } }] : []),
      { id: 'none', label: 'None, so the agent chooses', activate: select(null) }];
    };
    const screen = new ListScreen('saved workspaces', this.control, 'choose', rows);
    return this.draft.selected === null ? screen : screen.select(`saved:${this.draft.selected}`);
  }

  private folderList(workspace: SavedWorkspace): ListScreen {
    return new ListScreen(`roots of "${workspace.name}"`, this.control, 'add', () => {
      const current = selectedWorkspace(this.draft)?.roots ?? [];
      return [...current.map(root => ({ id: `root:${root.name}`, label: root.name, value: this.show(root.absolutePath),
        description: 'Del removes this folder.',
        remove: { label: 'remove', run: () => current.length > 1 ? this.change(editSelected(this.draft, edited => removeRoot(edited, root.name)))
          : this.control.say('A workspace needs one folder; delete the workspace from the saved workspace list instead.', 'error') } })),
      { id: 'add', label: '+ Add a root folder', activate: () => this.push(this.folderPicker('add a root folder',
        this.show(dirname(current[0]?.absolutePath ?? this.proposed)) + '/', folder => this.change(editSelected(this.draft, edited => addRoot(edited, folder))))) }];
    });
  }

  private newWorkspacePicker(): PathScreen {
    return this.folderPicker('new workspace: its first root folder', this.show(this.proposed) + '/',
      folder => this.change(createFromFolder(this.draft, folder)));
  }

  /** Picks an existing folder; `apply` receives it as the disk spells it. */
  private folderPicker(title: string, start: string, apply: (folder: string) => void): PathScreen {
    const accept = (folder: string) => {
      if (selectedWorkspace(this.draft)?.roots.some(root => root.absolutePath === folder)) return 'That folder is already in this workspace.';
      apply(folder);
      return null;
    };
    return new PathScreen(title, this.control, { base: this.base, include: 'folders', negatable: false, start,
      help: `~ is your home folder, and other relative paths start at ${this.show(this.ctx.cwd)}. Matching ignores case. Ctrl+u clears the line.`,
      target: text => { const found = resolveExisting(expand(text, this.base));
        return found.kind === 'folder' ? { label: `use ${this.show(found.path)}`, choose: () => accept(found.path) } : null; },
      chooseEntry: entry => accept(resolveExisting(entry.path).path) });
  }

  private outputPicker(workspace: SavedWorkspace): PathScreen {
    const apply = (outputRoot: string) => { this.change(editSelected(this.draft, edited => ({ ...edited, outputRoot }))); return null; };
    return new PathScreen('output folder', this.control, { base: this.base, include: 'folders', negatable: false,
      start: `${this.show(workspace.outputRoot)}/`,
      help: 'Packets are saved here. A folder that does not exist yet is created when you save.',
      target: text => { const found = resolveExisting(expand(text, this.base));
        if (found.kind === 'file') return null;
        return { label: `${found.kind === 'folder' ? 'use' : 'create when saved:'} ${this.show(found.path)}`, choose: () => apply(found.path) }; },
      chooseEntry: entry => apply(resolveExisting(entry.path).path) });
  }

  /** The lines of a root's `.mipmux_ignore`: the draft's edit, else the file as the panel first read it. */
  private ignoreFile(root: string): IgnoreFile {
    const edit = this.draft.ignoreEdits.find(item => item.root === root);
    if (edit) return { kind: 'read', lines: edit.lines };
    let read = this.ignoreReads.get(root);
    if (!read) { read = readIgnoreFile(root); this.ignoreReads.set(root, read); }
    return read;
  }

  /** Records new lines for a root's file; lines equal to the file as read leave nothing to save. */
  private setIgnoreLines(root: string, lines: readonly string[]): void {
    const read = this.ignoreReads.get(root), others = this.draft.ignoreEdits.filter(item => item.root !== root);
    const unchanged = read?.kind === 'read' && JSON.stringify(read.lines) === JSON.stringify(lines);
    this.change({ ...this.draft, ignoreEdits: unchanged ? others : [...others, { root, lines }] });
  }

  private ignoreSummary(workspace: SavedWorkspace): string {
    return workspace.roots.flatMap(root => {
      const file = this.ignoreFile(root.absolutePath);
      return file.kind === 'unreadable' ? [`${root.name}: cannot read`] : file.lines.filter(isRule).map(line => `${root.name}: ${line}`);
    }).join(', ') || 'none';
  }

  private ignoreList(): ListScreen {
    return new ListScreen('ignore rules', this.control, 'add', () => (selectedWorkspace(this.draft)?.roots ?? []).flatMap(root => {
      const path = ignoreFilePath(root.absolutePath), file = this.ignoreFile(root.absolutePath), section = `${root.name}  ${this.show(path)}`;
      if (file.kind === 'unreadable') return [{ id: `unreadable:${root.name}`, section, label: 'cannot read the file', description: file.problem }];
      const rules = file.lines.flatMap((line, index) => isRule(line) ? [{ line, index }] : []);
      const remove = (index: number) => () => this.setIgnoreLines(root.absolutePath, file.lines.filter((_line, at) => at !== index));
      const rows: ListRow[] = rules.map(({ line, index }) => ({ id: `rule:${root.name}:${index}`, label: line,
        description: line.startsWith('!') ? 'Brings back paths that another ignore file hides. Del removes the line.' : 'Leaves paths out. Del removes the line.',
        remove: { label: 'remove', run: remove(index) } }));
      rows.push({ id: `add:${root.name}`, label: `+ Add a rule to ${root.name}`, activate: () => this.push(this.rulePicker(root, file.lines)) });
      const [first, ...rest] = rows;
      return first ? [{ ...first, section }, ...rest] : [];
    }));
  }

  private rulePicker(root: Workspace['roots'][number], lines: readonly string[]): PathScreen {
    const base = { base: root.absolutePath, home: this.host.home };
    const add = (line: string) => {
      if (lines.includes(line)) return 'That rule is already in the file.';
      this.setIgnoreLines(root.absolutePath, [...lines, line]);
      return null;
    };
    return new PathScreen(`rule for ${root.name}`, this.control, { base, include: 'all', start: '', negatable: true,
      help: `A path in ${this.show(root.absolutePath)}, relative to it, or a pattern such as *.log, written to ${ignoreFileName} ` +
        'there. Start with ! to bring back a path that another ignore file hides; nothing brings back what .gitignore hides.',
      target: text => {
        const choice = typedRule(text, base);
        return choice.kind === 'refused' ? { label: choice.reason, choose: () => choice.reason }
          : { label: `${choice.line.startsWith('!') ? 'bring back' : 'leave out'}: ${choice.line}`, choose: () => add(choice.line) };
      },
      chooseEntry: (entry, negated) => add(entryRule(root.absolutePath, entry, negated)) });
  }
}

/** The Git repository containing `cwd`, or `cwd` itself outside a repository: where a new workspace's folder picker starts. */
async function proposedRoot(cwd: string): Promise<string> {
  return promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd }).then(result => result.stdout.trim(), () => cwd);
}

/** Opens the panel until the user closes it. A saved-workspace file that cannot be read is reported instead, unchanged. */
export async function openPanel(ctx: PanelContext, host: PanelHost): Promise<void> {
  let saved: Store;
  try { saved = await readStore(host.storePath); }
  catch (error) {
    if (!(error instanceof StoreError)) throw error;
    ctx.ui.notify(`mipmux cannot open the saved workspaces until the file is fixed: ${error.message}`, 'error');
    return;
  }
  const config = await readServerConfig(host.mipmux);
  const proposed = await proposedRoot(ctx.cwd);
  await ctx.ui.custom((tui, theme, keybindings, done) => new PanelComponent({ ctx, host, saved, config, proposed, tui, theme, keybindings, done }));
}
