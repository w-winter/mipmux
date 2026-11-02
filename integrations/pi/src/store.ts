import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { mergeDuplicates, SavedWorkspace, type Merge } from './state.ts';

/*
 * The saved workspaces and display settings in `<Pi agent dir>/mipmux.json`, shared by every Pi session of the user. The
 * file is hand-editable, so every read validates it; every write merges duplicates first. Two sessions writing at the
 * same instant can lose one update, which is acceptable for rare, user-initiated changes.
 */
const StoreFile = Type.Object({ workspaces: Type.Array(SavedWorkspace), showInFooter: Type.Optional(Type.Boolean()) },
  { additionalProperties: false });
const storeValidator = Compile(StoreFile);
/** The file's contents; a file without `showInFooter` shows the footer item. */
export interface Store {
  readonly workspaces: SavedWorkspace[];
  /** Whether every session shows `mipmux: <workspace>` in Pi's footer. */
  readonly showInFooter: boolean;
}
const emptyStore: Store = { workspaces: [], showInFooter: true };

/** The store cannot be read or holds an invalid file; the message names the file and its first problem. */
export class StoreError extends Error {}

function invalid(path: string, problem: string): StoreError { return new StoreError(`${path}: ${problem}`); }

/** The file's contents; a missing file holds no workspaces and shows the footer item. */
export async function readStore(path: string): Promise<Store> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyStore;
    throw invalid(path, error instanceof Error ? error.message : 'unreadable');
  }
  return parseStore(path, text);
}

/** `readStore` for callers that must answer at once, such as command completions. */
export function readStoreSync(path: string): Store {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyStore;
    throw invalid(path, error instanceof Error ? error.message : 'unreadable');
  }
  return parseStore(path, text);
}

function parseStore(path: string, text: string): Store {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw invalid(path, 'not valid JSON'); }
  if (!storeValidator.Check(value)) {
    // A closed object first reports the unexpected property itself, then the object that holds it.
    const errors = storeValidator.Errors(value), error = errors.find(item => item.keyword !== 'boolean') ?? errors[0];
    throw invalid(path, `${error?.instancePath || '/'} ${error?.message ?? 'is invalid'}`);
  }
  checkNames(path, value.workspaces);
  return { workspaces: value.workspaces, showInFooter: value.showInFooter ?? true };
}

/** Workspace names are unique, and root names are unique within a workspace. */
function checkNames(path: string, workspaces: readonly SavedWorkspace[]): void {
  const names = new Set<string>();
  for (const workspace of workspaces) {
    if (names.has(workspace.name)) throw invalid(path, `"${workspace.name}" is saved twice`);
    names.add(workspace.name);
    if (new Set(workspace.roots.map(root => root.name)).size !== workspace.roots.length) throw invalid(path, `"${workspace.name}" names a root twice`);
  }
}

/** Applies `change` to the file's contents, merges duplicate workspaces and replaces the file with the result. */
export async function updateStore(path: string, change: (store: Store) => Store): Promise<Store & { merges: Merge[] }> {
  const changed = change(await readStore(path)), merged = mergeDuplicates(changed.workspaces);
  checkNames(path, merged.workspaces);
  const store: Store = { workspaces: merged.workspaces, showInFooter: changed.showInFooter };
  const temporary = join(dirname(path), `.mipmux.json.${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
  return { ...store, merges: merged.merges };
}
