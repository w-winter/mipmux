import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { expand, resolveExisting, type PathBase, type PathEntry } from './paths.ts';

/*
 * A root's `.mipmux_ignore`, in gitignore syntax. mipmux reads one in every folder; the panel edits the one at each root.
 * Its rules belong to the folder, so they apply to every workspace and client that uses it.
 */
export const ignoreFileName = '.mipmux_ignore';
const globCharacters = /[*?[\]]/;
/** The lines of a root's `.mipmux_ignore` as the panel read them, or why it could not read them. */
export type IgnoreFile = { readonly kind: 'read'; readonly lines: readonly string[] } | { readonly kind: 'unreadable'; readonly problem: string };
/** A line the picker would add, or why it refuses the typed text. */
export type RuleChoice = { readonly kind: 'rule'; readonly line: string } | { readonly kind: 'refused'; readonly reason: string };

export const ignoreFilePath = (root: string) => join(root, ignoreFileName);
/** A line that is a rule rather than a blank line or a comment. */
export const isRule = (line: string) => line.trim() !== '' && !line.startsWith('#');

function lines(text: string): string[] {
  const split = text.split('\n');
  return split.at(-1) === '' ? split.slice(0, -1) : split;
}

/** Reads a root's file; a missing file has no lines. */
export function readIgnoreFile(root: string): IgnoreFile {
  try { return { kind: 'read', lines: lines(readFileSync(ignoreFilePath(root), 'utf8')) }; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'read', lines: [] };
    return { kind: 'unreadable', problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Replaces a root's file with `next`. Fails, writing nothing, when the file no longer holds `read`, so a hand edit made
 * while the panel was open is never overwritten.
 */
export async function writeIgnoreFile(root: string, read: readonly string[], next: readonly string[]): Promise<void> {
  const path = ignoreFilePath(root);
  const current = await readFile(path, 'utf8').then(lines, (error: Error & { code?: string }) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (JSON.stringify(current) !== JSON.stringify(read)) throw new Error(`${path} changed while the panel was open; close the panel and open it again.`);
  const temporary = join(root, `.mipmux_ignore.${randomUUID()}`);
  await writeFile(temporary, next.map(line => `${line}\n`).join(''));
  await rename(temporary, path);
}

/** The rule for a path inside `root`: relative to it, anchored to it, and ending in `/` for a folder. */
function pathRule(root: string, path: string, folder: boolean): string | null {
  const under = relative(root, path);
  if (!under || under.startsWith('..') || isAbsolute(under)) return null;
  return (under.includes('/') ? under : `/${under}`) + (folder ? '/' : '');
}

/** The rule for a completion the user chose; `negated` brings the path back instead of leaving it out. */
export function entryRule(root: string, entry: PathEntry, negated: boolean): string {
  const found = resolveExisting(entry.path);
  return (negated ? '!' : '') + (pathRule(root, found.path, found.kind === 'folder') ?? entry.name);
}

/**
 * The rule for typed text. A leading `!` brings paths back. A path that exists inside the root becomes a rule anchored to
 * the root; `~` or an absolute path must lie inside it. Anything else, such as `*.log` or a path that does not exist yet,
 * is kept as a gitignore pattern as typed.
 */
export function typedRule(text: string, base: PathBase): RuleChoice {
  if (text.startsWith('#')) return { kind: 'refused', reason: 'A line starting with # is a comment, not a rule.' };
  const negated = text.startsWith('!'), body = negated ? text.slice(1) : text, marker = negated ? '!' : '';
  if (!body) return { kind: 'refused', reason: 'Type a path or a pattern.' };
  if (globCharacters.test(body)) return { kind: 'rule', line: marker + body };
  const found = resolveExisting(expand(body, base));
  const rule = found.kind === 'missing' ? null : pathRule(base.base, found.path, found.kind === 'folder');
  if (rule) return { kind: 'rule', line: marker + rule };
  if (body.startsWith('~') || (isAbsolute(body) && found.kind !== 'missing')) {
    return { kind: 'refused', reason: `That path is outside ${base.base}.` };
  }
  return { kind: 'rule', line: marker + body };
}
