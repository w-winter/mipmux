import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { mergeDuplicates, SavedWorkspace, type Merge } from './state.ts';

/*
 * The saved workspaces in `<Pi agent dir>/mipmux.json`, shared by every Pi session of the user. The file is hand-editable,
 * so every read validates it; every write merges duplicates first. Two sessions writing at the same instant can lose one
 * update, which is acceptable for rare, user-initiated changes.
 */
const StoreFile = Type.Object({ workspaces: Type.Array(SavedWorkspace) }, { additionalProperties: false });
const storeValidator = Compile(StoreFile);

/** The store cannot be read or holds an invalid file; the message names the file and its first problem. */
export class StoreError extends Error {}

function invalid(path: string, problem: string): StoreError { return new StoreError(`${path}: ${problem}`); }

/** The saved workspaces; a missing file holds none. */
export async function readStore(path: string): Promise<SavedWorkspace[]> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw invalid(path, error instanceof Error ? error.message : 'unreadable');
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw invalid(path, 'not valid JSON'); }
  if (!storeValidator.Check(value)) {
    // A closed object first reports the unexpected property itself, then the object that holds it.
    const errors = storeValidator.Errors(value), error = errors.find(item => item.keyword !== 'boolean') ?? errors[0];
    throw invalid(path, `${error?.instancePath || '/'} ${error?.message ?? 'is invalid'}`);
  }
  checkNames(path, value.workspaces);
  return value.workspaces;
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

/** Applies `change` to the saved workspaces, merges duplicates and replaces the file with the result. */
export async function updateStore(path: string, change: (workspaces: SavedWorkspace[]) => SavedWorkspace[]):
  Promise<{ workspaces: SavedWorkspace[]; merges: Merge[] }> {
  const merged = mergeDuplicates(change(await readStore(path)));
  checkNames(path, merged.workspaces);
  const temporary = join(dirname(path), `.mipmux.json.${randomUUID()}`);
  await writeFile(temporary, JSON.stringify({ workspaces: merged.workspaces }, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
  return merged;
}
