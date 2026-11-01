import type { ExtensionContext, ExtensionUIContext, ToolResultEvent, ToolResultEventResult } from '@earendil-works/pi-coding-agent';
import { readStore, StoreError } from './store.ts';
import { recognize } from './routes.ts';
import { openPanel, report } from './panel.ts';
import type { MipmuxConfig } from './config.ts';
import { conflictNote, decide, declaredWorkspace, emptyState, sameWorkspace, selectedInstruction, sessionStateValidator,
  type CallArgs, type SavedWorkspace, type Selection, type SessionState } from './state.ts';

/** The parts of Pi's extension context the extension uses. */
export type MipmuxContext = Pick<ExtensionContext, 'hasUI' | 'cwd'> & {
  readonly ui: Pick<ExtensionUIContext, 'select' | 'input' | 'confirm' | 'notify' | 'setStatus'>;
  readonly sessionManager: Pick<ExtensionContext['sessionManager'], 'getBranch'>;
};
export interface MipmuxDependencies {
  /** `<Pi agent dir>/mipmux.json`. */
  readonly storePath: string;
  /** Records `state` in the session log, where `restore` finds it on resume, fork or tree navigation. */
  appendEntry(state: SessionState): void;
  readConfig(): Promise<MipmuxConfig>;
}
export const entryType = 'mipmux';

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

  /** The selected saved workspace as the store holds it now; read on every use, so edits reach every session. */
  async function lookup(): Promise<Selection> {
    const name = state.selected;
    if (name === null) return { kind: 'none' };
    let saved: SavedWorkspace[];
    try { saved = await readStore(dependencies.storePath); }
    catch (error) {
      if (error instanceof StoreError) return { kind: 'unreadable', name, message: error.message };
      throw error;
    }
    const workspace = saved.find(entry => entry.name === name);
    return workspace ? { kind: 'found', workspace } : { kind: 'missing', name, saved: saved.map(entry => entry.name) };
  }
  async function showStatus(ctx: MipmuxContext): Promise<void> { ctx.ui.setStatus(entryType, statusText(await lookup())); }
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
    async beforeAgentStart(event: { readonly systemPromptOptions: { readonly sections: Record<string, string> } }): Promise<void> {
      const selection = await lookup();
      if (selection.kind === 'found') event.systemPromptOptions.sections.mipmux_workspace = selectedInstruction(selection.workspace);
    },
    async toolCall(event: { readonly toolName: string; readonly toolCallId: string; readonly input: CallArgs }, ctx: MipmuxContext) {
      const call = recognize(event.toolName, event.input);
      if (!call) return undefined;
      if (call.kind === 'malformed') return { block: true, reason: call.reason };
      const decision = decide(call.tool, call.args, await lookup(), state.preferences, ctx.hasUI);
      if (decision.kind === 'blocked') return { block: true, reason: decision.reason };
      if (decision.changed) { call.commit(); changed.add(event.toolCallId); }
      const declared = declaredWorkspace(call.args);
      if (declared && !sameWorkspace(declared, state.lastDeclared)) await record({ ...state, lastDeclared: declared }, ctx);
      return undefined;
    },
    /** Explains a conflict that this extension's changes caused, on the result of the call it changed. */
    toolResult(event: Pick<ToolResultEvent, 'toolCallId' | 'content' | 'structuredContent'>): ToolResultEventResult | undefined {
      if (!changed.delete(event.toolCallId)) return undefined;
      if (!event.content.some(block => block.type === 'text' && block.text.includes('"outputNameConflict"'))) return undefined;
      const result: ToolResultEventResult = { content: [...event.content, { type: 'text', text: conflictNote }] };
      if (event.structuredContent !== undefined) result.structuredContent = event.structuredContent;
      return result;
    },
    /** `/mipmux <name>` selects a saved workspace; `/mipmux` opens the panel, or reports the state without a UI. */
    async command(args: string, ctx: MipmuxContext): Promise<void> {
      const name = args.trim();
      if (name) {
        const saved = await readStore(dependencies.storePath);
        if (!saved.some(entry => entry.name === name)) {
          ctx.ui.notify(`No saved workspace named "${name}". Saved workspaces: ${saved.map(entry => entry.name).join(', ') || 'none'}.`, 'error');
          return;
        }
        await record({ ...state, selected: name }, ctx);
        return;
      }
      if (ctx.hasUI) await openPanel(ctx, { storePath: dependencies.storePath, state: () => state, record, readConfig: dependencies.readConfig });
      else ctx.ui.notify(report(state, await lookup()), 'info');
    },
    async completions(prefix: string) {
      const saved = await readStore(dependencies.storePath);
      return saved.filter(entry => entry.name.startsWith(prefix)).map(entry => ({ value: entry.name, label: entry.name }));
    },
  };
}
