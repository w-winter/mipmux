import type { ExtensionContext, ExtensionUIContext, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { readStore, readStoreSync, StoreError, type Store } from './store.ts';
import { recognize } from './routes.ts';
import { openPanel, type PanelContext } from './panel.ts';
import { report } from './report.ts';
import type { MipmuxCommands } from './config.ts';
import { conflictNote, decide, declaredWorkspace, emptyState, sameWorkspace, selectedInstruction, sessionStateValidator,
  type CallArgs, type Decision, type Selection, type SessionState } from './state.ts';

/** The parts of Pi's extension context the extension uses. */
export type MipmuxContext = Pick<ExtensionContext, 'hasUI' | 'cwd' | 'mode'> & {
  readonly ui: Pick<ExtensionUIContext, 'notify' | 'setStatus'> & Pick<PanelContext['ui'], 'custom'>;
  readonly sessionManager: Pick<ExtensionContext['sessionManager'], 'getBranch'>;
};
export interface MipmuxDependencies {
  /** `<Pi agent dir>/mipmux.json`. */
  readonly storePath: string;
  /** The user's home folder, which `~` names in the panel's path fields. */
  readonly home: string;
  /** Records `state` in the session log, where `restore` finds it on resume, fork or tree navigation. */
  appendEntry(state: SessionState): void;
  readonly mipmux: MipmuxCommands;
}
export const entryType = 'mipmux';
/** The name of the system prompt section that carries the selected workspace. */
export const workspaceSection = 'mipmux_workspace';
const untouched: Decision = { kind: 'allowed', changed: false };

function statusText(selection: Selection): string {
  switch (selection.kind) {
    case 'none': return 'mipmux: no workspace';
    case 'found': return `mipmux: ${selection.workspace.name}`;
    case 'missing': return `mipmux: ${selection.name} (missing)`;
    case 'unreadable': return `mipmux: ${selection.name} (file error)`;
  }
}

/**
 * One extension instance per Pi runtime. Its session state is rebuilt from the session log whenever the session starts
 * or its branch changes, and replaced, never merged, on every change, so the last entry on a branch is complete.
 */
export function createMipmux(dependencies: MipmuxDependencies) {
  let state: SessionState = emptyState;
  // Calls whose arguments this extension changed, until their results arrive.
  const changed = new Set<string>();

  /** The saved-workspace file as it is now, or why it cannot be read; read on every use, so edits reach every session. */
  async function current(): Promise<Store | StoreError> {
    try { return await readStore(dependencies.storePath); }
    catch (error) {
      if (error instanceof StoreError) return error;
      throw error;
    }
  }
  /** The selected saved workspace as `store` holds it. */
  function selection(store: Store | StoreError): Selection {
    const name = state.selected;
    if (name === null) return { kind: 'none' };
    if (store instanceof StoreError) return { kind: 'unreadable', name, message: store.message };
    const workspace = store.workspaces.find(entry => entry.name === name);
    return workspace ? { kind: 'found', workspace } : { kind: 'missing', name, saved: store.workspaces.map(entry => entry.name) };
  }
  async function lookup(): Promise<Selection> { return selection(await current()); }
  /** Shows the selection in Pi's footer, or clears the item when the user turned it off; an unreadable file keeps it, to report the problem. */
  function display(store: Store | StoreError, ctx: MipmuxContext): void {
    const shown = store instanceof StoreError || store.showInFooter;
    ctx.ui.setStatus(entryType, shown ? statusText(selection(store)) : undefined);
  }
  async function showStatus(ctx: MipmuxContext): Promise<void> { display(await current(), ctx); }
  async function record(next: SessionState, ctx: MipmuxContext): Promise<void> {
    state = next;
    dependencies.appendEntry(next);
    await showStatus(ctx);
  }

  return {
    state: (): SessionState => state,
    record,
    async restore(ctx: MipmuxContext): Promise<void> {
      const branch = ctx.sessionManager.getBranch();
      let restored: SessionState = emptyState;
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry?.type === 'custom' && entry.customType === entryType) { restored = sessionStateValidator.Parse(entry.data); break; }
      }
      state = restored;
      await showStatus(ctx);
    },
    /**
     * Refreshes the footer, which another session may have turned off or on, and returns the text of the
     * `workspaceSection` prompt section for the selected workspace, or null when none is selected.
     */
    async beforeAgentStart(ctx: MipmuxContext): Promise<string | null> {
      const store = await current(), found = selection(store);
      display(store, ctx);
      return found.kind === 'found' ? selectedInstruction(found.workspace) : null;
    },
    /** Applies the session's choices to a mipmux call by editing `event.input` in place; other tools are left alone. */
    async toolCall(event: { readonly toolName: string; readonly toolCallId: string; readonly input: CallArgs }, ctx: MipmuxContext): Promise<Decision> {
      const tool = recognize(event.toolName);
      if (!tool) return untouched;
      const decision = decide(tool, event.input, await lookup(), state.preferences, ctx.hasUI);
      if (decision.kind === 'blocked') return decision;
      if (decision.changed) changed.add(event.toolCallId);
      const declared = declaredWorkspace(event.input);
      if (declared && !sameWorkspace(declared, state.lastDeclared)) await record({ ...state, lastDeclared: declared }, ctx);
      return decision;
    },
    /** The result content with a note added when this extension's changes caused a conflict, or undefined to keep it. */
    toolResult(event: Pick<ToolResultEvent, 'toolCallId' | 'content'>): ToolResultEvent['content'] | undefined {
      if (!changed.delete(event.toolCallId)) return undefined;
      if (!event.content.some(block => block.type === 'text' && block.text.includes('"outputNameConflict"'))) return undefined;
      return [...event.content, { type: 'text', text: conflictNote }];
    },
    /** `/mipmux <name>` selects a saved workspace; `/mipmux` opens the panel in Pi's terminal UI and reports the state elsewhere. */
    async command(args: string, ctx: MipmuxContext): Promise<void> {
      const name = args.trim();
      if (name) {
        const saved = (await readStore(dependencies.storePath)).workspaces;
        if (!saved.some(entry => entry.name === name)) {
          ctx.ui.notify(`No saved workspace named "${name}". Saved workspaces: ${saved.map(entry => entry.name).join(', ') || 'none'}.`, 'error');
          return;
        }
        await record({ ...state, selected: name }, ctx);
        return;
      }
      if (ctx.mode === 'tui') {
        await openPanel(ctx, { storePath: dependencies.storePath, home: dependencies.home, state: () => state,
          record: next => record(next, ctx), mipmux: dependencies.mipmux });
      } else ctx.ui.notify(report(state, await lookup()), 'info');
    },
    completions(prefix: string) {
      const saved = readStoreSync(dependencies.storePath).workspaces;
      return saved.filter(entry => entry.name.startsWith(prefix)).map(entry => ({ value: entry.name, label: entry.name }));
    },
  };
}
