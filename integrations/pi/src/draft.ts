import { basename } from 'node:path';
import type { ServerDefaults } from './server-config.ts';
import type { Store } from './store.ts';
import { type Preferences, type SavedWorkspace, type SessionState, type Workspace } from './state.ts';

/*
 * The panel's unsaved changes. The panel edits a draft and writes it only on ctrl+s; closing discards it. A save applies
 * only the saved workspaces the panel added, changed or deleted, so changes another session saved meanwhile survive, and
 * writes only the `.mipmux_ignore` files the panel changed.
 */
/** A saved workspace in the draft; `origin` is its name in the file when the panel read it, or null for a new one. */
export interface DraftEntry { readonly origin: string | null; readonly workspace: SavedWorkspace }
/** The complete new lines of one root's `.mipmux_ignore`. */
export interface IgnoreEdit { readonly root: string; readonly lines: readonly string[] }
export interface Draft {
  readonly entries: readonly DraftEntry[];
  readonly selected: string | null;
  readonly preferences: Preferences;
  readonly ignoreEdits: readonly IgnoreEdit[];
  /** mipmux's request defaults, or null when `mipmux config` could not report them. */
  readonly server: ServerDefaults | null;
  /** Whether every session shows the footer item. */
  readonly showInFooter: boolean;
}
const rootNamePattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function openDraft(store: Store, state: SessionState, server: ServerDefaults | null): Draft {
  return { entries: store.workspaces.map(workspace => ({ origin: workspace.name, workspace })), selected: state.selected,
    preferences: state.preferences, ignoreEdits: [], server, showInFooter: store.showInFooter };
}

export function selectedWorkspace(draft: Draft): SavedWorkspace | null {
  return draft.entries.find(entry => entry.workspace.name === draft.selected)?.workspace ?? null;
}

/** `base`, or `base (1)`, `base (2)` and so on, whichever is free first, as RepoPrompt CE names workspaces. */
export function uniqueName(base: string, taken: readonly string[]): string {
  let name = base;
  for (let counter = 1; taken.includes(name); counter++) name = `${base} (${counter})`;
  return name;
}

/** A root name from the folder's name, in the form mipmux accepts, distinct from the workspace's other roots. */
function rootName(path: string, roots: Workspace['roots']): string {
  const cleaned = basename(path).replace(/[^A-Za-z0-9_-]/g, '-');
  const base = rootNamePattern.test(cleaned) ? cleaned : `root-${cleaned}`;
  let name = base;
  for (let counter = 2; roots.some(root => root.name === name); counter++) name = `${base}-${counter}`;
  return name;
}

/** Adds the roots and output folder of `workspace`, such as one the agent declared, under a name taken from its first root, and selects it. */
export function addWorkspace(draft: Draft, workspace: Pick<Workspace, 'roots' | 'outputRoot'>): Draft {
  const first = workspace.roots[0]?.absolutePath ?? 'workspace';
  const name = uniqueName(basename(first), draft.entries.map(entry => entry.workspace.name));
  const added: SavedWorkspace = { name, roots: workspace.roots, outputRoot: workspace.outputRoot };
  return { ...draft, entries: [...draft.entries, { origin: null, workspace: added }], selected: name };
}

/** A new saved workspace with one root, `<root>/prompt-exports` as its output folder, named after the root and selected. */
export function createFromFolder(draft: Draft, folder: string): Draft {
  return addWorkspace(draft, { roots: [{ name: rootName(folder, []), absolutePath: folder }], outputRoot: `${folder}/prompt-exports` });
}

/** Replaces the selected saved workspace with `change(workspace)`. */
export function editSelected(draft: Draft, change: (workspace: SavedWorkspace) => SavedWorkspace): Draft {
  return { ...draft, entries: draft.entries.map(entry => entry.workspace.name === draft.selected ? { ...entry, workspace: change(entry.workspace) } : entry) };
}

export function addRoot(workspace: SavedWorkspace, folder: string): SavedWorkspace {
  return { ...workspace, roots: [...workspace.roots, { name: rootName(folder, workspace.roots), absolutePath: folder }] };
}

export function removeRoot(workspace: SavedWorkspace, name: string): SavedWorkspace {
  return { ...workspace, roots: workspace.roots.filter(root => root.name !== name) };
}

/** Renames the selected saved workspace; fails with a reason when the name is empty or taken. */
export function renameSelected(draft: Draft, name: string): Draft | { readonly problem: string } {
  if (!name) return { problem: 'A name needs at least one character.' };
  if (name !== draft.selected && draft.entries.some(entry => entry.workspace.name === name)) return { problem: `"${name}" is already saved.` };
  return { ...editSelected(draft, workspace => ({ ...workspace, name })), selected: name };
}

export function deleteWorkspace(draft: Draft, name: string): Draft {
  return { ...draft, entries: draft.entries.filter(entry => entry.workspace.name !== name), selected: draft.selected === name ? null : draft.selected };
}

/**
 * The draft's additions, edits and deletions applied to the saved workspaces as the file holds them now: an edit keeps its
 * entry's place, and a new workspace, or one another session deleted meanwhile, is added at the end.
 */
export function applyDraft(stored: readonly SavedWorkspace[], draft: Draft, snapshot: readonly SavedWorkspace[]): SavedWorkspace[] {
  const unchanged = (entry: DraftEntry) => snapshot.some(saved => saved.name === entry.origin && JSON.stringify(saved) === JSON.stringify(entry.workspace));
  const changed = draft.entries.filter(entry => !unchanged(entry));
  const deleted = snapshot.filter(saved => !draft.entries.some(entry => entry.origin === saved.name)).map(saved => saved.name);
  const kept = stored.filter(saved => !deleted.includes(saved.name))
    .map(saved => changed.find(entry => entry.origin === saved.name)?.workspace ?? saved);
  const added = changed.filter(entry => entry.origin === null || !stored.some(saved => saved.name === entry.origin));
  return [...kept, ...added.map(entry => entry.workspace)];
}
