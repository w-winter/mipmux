import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

/*
 * Path completion for the panel's folder and exclusion pickers. The user types a path as in a shell: `~` names the home
 * folder and a relative path starts at the picker's base folder. Matching ignores case, ranks names as the
 * editor-enhancements file picker's best-match mode does, and completion writes each name as the disk spells it.
 */
export interface PathBase {
  /** The folder a relative path starts from. */
  readonly base: string;
  readonly home: string;
}
export interface PathEntry { readonly name: string; readonly path: string; readonly folder: boolean }
/** Typed text split at its last separator: the folder to complete in, and the name typed so far. */
export interface TypedPath { readonly folder: string; readonly partial: string }
/** What a typed path names: an entry on disk, spelled as the disk spells it, or a path nothing exists at yet. */
export type Resolved = { readonly kind: 'folder' | 'file'; readonly path: string } | { readonly kind: 'missing'; readonly path: string };

/** The absolute path `text` names, without a trailing separator. */
export function expand(text: string, { base, home }: PathBase): string {
  const homeRelative = text === '~' || text.startsWith('~/') ? join(home, text.slice(1)) : text;
  return resolve(isAbsolute(homeRelative) ? homeRelative : join(base, homeRelative));
}

/** `path` as the picker shows it: under the home folder it starts with `~`. */
export function abbreviate(path: string, home: string): string {
  if (path === home) return '~';
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** The folder whose entries complete `text`, and the partial name typed after its last separator. */
export function split(text: string, base: PathBase): TypedPath {
  if (text === '~') return { folder: base.home, partial: '' };
  const cut = text.lastIndexOf('/');
  return cut === -1 ? { folder: base.base, partial: text } : { folder: expand(text.slice(0, cut + 1) || '/', base), partial: text.slice(cut + 1) };
}

/** How well `name` matches `query`, ignoring case; 0 when it does not match. Shorter names win among prefix matches. */
function score(query: string, name: string): number {
  const typed = query.toLowerCase(), candidate = name.toLowerCase();
  const alphanumeric = (text: string) => text.replace(/[^a-z0-9]/g, '');
  if (candidate === typed) return 1000;
  if (candidate.startsWith(typed)) return 800 - name.length;
  if (alphanumeric(typed) && alphanumeric(candidate).startsWith(alphanumeric(typed))) return 600 - name.length;
  const index = candidate.indexOf(typed);
  if (index !== -1) return 400 - index;
  let position = 0;
  for (const character of candidate) if (character === typed[position]) position++;
  return position === typed.length ? 100 : 0;
}

// While the user types, a path often names nothing yet, or something they cannot read; such a path lists nothing.
const absent = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP']);

/** What `read` returns, or nothing when the path it reads is missing or unreadable. */
function orNothing<T>(read: () => T[]): T[] {
  try { return read(); }
  catch (error) {
    if (error instanceof Error && 'code' in error && absent.has(String(error.code))) return [];
    throw error;
  }
}

/** The entries of `folder`, as a directory listing gives them; a missing or unreadable folder lists nothing. */
function entries(folder: string): PathEntry[] {
  return orNothing(() => readdirSync(folder)).flatMap(name => {
    const path = join(folder, name);
    return orNothing(() => [{ name, path, folder: statSync(path).isDirectory() }]);
  });
}

/**
 * The entries of `folder` that match `partial`, best first; with no partial, every entry by name. Hidden entries appear
 * only once the partial starts with a dot.
 */
export function candidates(folder: string, partial: string, include: 'folders' | 'all'): PathEntry[] {
  const listed = entries(folder).filter(entry => (include === 'all' || entry.folder) && (partial.startsWith('.') || !entry.name.startsWith('.')));
  if (!partial) return listed.sort((a, b) => a.name.localeCompare(b.name));
  return listed.map(entry => ({ entry, score: score(partial, entry.name) })).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name)).map(item => item.entry);
}

/**
 * What `path` names on disk. Each segment takes the disk's spelling: an exact match first, otherwise the one entry that
 * matches ignoring case, so `/users/me` resolves to `/Users/me` on a case-insensitive volume and stays missing where case
 * matters. Symbolic links are kept, not resolved.
 */
export function resolveExisting(path: string): Resolved {
  let current = '/';
  for (const segment of path.split('/').filter(Boolean)) {
    const listed = entries(current).map(entry => entry.name);
    const insensitive = listed.filter(name => name.toLowerCase() === segment.toLowerCase());
    const spelled = listed.includes(segment) ? segment : insensitive.length === 1 ? insensitive[0] : undefined;
    if (spelled === undefined) return { kind: 'missing', path };
    current = join(current, spelled);
  }
  return { kind: statSync(current).isDirectory() ? 'folder' : 'file', path: current };
}
