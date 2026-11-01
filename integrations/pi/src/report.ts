import { effectiveValue, type Preference, type SessionState, type Selection, type Source } from './state.ts';

/*
 * The effective state as text, for /mipmux in sessions without Pi's terminal UI. It names the layer each value comes from;
 * values left to the server show as the server default, which this report does not read.
 */
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

function line<T>(label: string, session: Preference<T> | undefined, saved: Preference<T> | undefined, format: (value: T) => string): string {
  const effective = effectiveValue(session, saved, undefined);
  return effective.value === undefined ? `${label}: server default` : `${label}: ${format(effective.value)} (${sourceLabel(effective.source)})`;
}

export function workspaceLine(selection: Selection): string {
  switch (selection.kind) {
    case 'none': return 'workspace: none selected';
    case 'found': return `workspace: ${selection.workspace.name}`;
    case 'missing': return `workspace: ${selection.name} (no longer saved)`;
    case 'unreadable': return `workspace: ${selection.name} (${selection.message})`;
  }
}

export function report(state: SessionState, selection: Selection): string {
  const workspace = selection.kind === 'found' ? selection.workspace : null, preferences = state.preferences;
  return [workspaceLine(selection), line('budget', preferences.budgetUnits, undefined, value => `${value} units`),
    line('enhancement mode', preferences.enhancementMode, undefined, String),
    line('clarification', preferences.clarification, undefined, value => value.enabled ? 'on' : 'off'),
    line('discovery model', preferences.model, workspace?.model, String),
    line('thinking level', preferences.thinking, workspace?.thinking, String)].join('\n');
}
