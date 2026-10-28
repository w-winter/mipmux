import { join } from 'node:path';
import type { Static } from 'typebox';
import type { IgnoreAuthority } from '../contracts/inventory.js';
import type { ProcessSupervisor } from '../runtime/process-supervisor.js';
import { gitProcess, type GitUserConfiguration } from '../patches/git-process.js';
import { WorkspaceFailure } from './values.js';

/** A repository's Git directory and working tree, as canonical paths. */
export interface GitRepositoryLocation { readonly gitDirectory: string; readonly worktree: string }

/**
 * Supplies the paths of the untracked files and directories that Git ignores beneath a root, relative to the root. A listed
 * directory contains no tracked files, and Git ignores everything beneath it.
 */
export interface GitExclusionSource {
  paths(root: string, authority: Static<typeof IgnoreAuthority>, rootPath: string): Promise<ReadonlySet<string>>;
}

const noPaths: ReadonlySet<string> = new Set();

/** Whether `path`, relative to a root, is one of the root's excluded `paths` or lies beneath one. */
export function gitExcluded(paths: ReadonlySet<string>, path: string): boolean {
  for (let current = path; current !== ''; current = current.slice(0, Math.max(current.lastIndexOf('/'), 0))) {
    if (paths.has(current)) return true;
  }
  return false;
}

/** The exclusions one refresh obtained from Git, by root; a root it did not ask about has none. */
export class GitExclusions implements GitExclusionSource {
  static readonly none = new GitExclusions(new Map());
  readonly #byRoot: ReadonlyMap<string, ReadonlySet<string>>;
  constructor(byRoot: ReadonlyMap<string, ReadonlySet<string>>) { this.#byRoot = byRoot; }
  paths(root: string): Promise<ReadonlySet<string>> { return Promise.resolve(this.#byRoot.get(root) ?? noPaths); }
}

/** Asks Git through `list` at most once per root and keeps each root's answer. */
export class GitExclusionQuery implements GitExclusionSource {
  readonly #byRoot = new Map<string, Promise<ReadonlySet<string>>>();
  readonly #list: (authority: Static<typeof IgnoreAuthority>, rootPath: string) => Promise<ReadonlySet<string>>;
  constructor(list: (authority: Static<typeof IgnoreAuthority>, rootPath: string) => Promise<ReadonlySet<string>>) { this.#list = list; }
  paths(root: string, authority: Static<typeof IgnoreAuthority>, rootPath: string): Promise<ReadonlySet<string>> {
    let paths = this.#byRoot.get(root);
    if (!paths) { paths = this.#list(authority, rootPath); this.#byRoot.set(root, paths); }
    return paths;
  }
  /** The answers obtained so far. A root whose query failed is left out; the scan that asked reports that root's failure. */
  async answers(): Promise<GitExclusions> {
    const settled = await Promise.all([...this.#byRoot].map(async ([root, paths]) =>
      [root, await paths.then(value => value, () => null)] as const));
    return new GitExclusions(new Map(settled.flatMap(([root, paths]) => paths === null ? [] : [[root, paths] as const])));
  }
}

/** The `-c` arguments that make Git apply `excludesFile`; none when there is no user configuration to name one. */
export function excludesArguments(excludesFile: string | null): string[] {
  return excludesFile === null ? [] : ['-c', 'core.excludesFile=' + excludesFile];
}

/**
 * The excludes file Git applies in a repository under the user's configuration: the repository's or the user's
 * `core.excludesFile`, or Git's default `git/ignore` beneath `xdgConfigHome` or `~/.config`.
 */
export async function resolveExcludesFile(supervisor: ProcessSupervisor, executable: string, user: GitUserConfiguration,
  repository: GitRepositoryLocation, signal: AbortSignal): Promise<string> {
  const result = await gitProcess(supervisor, executable, repository.worktree, ['config', '--type=path', '--get', 'core.excludesFile'],
    signal, { kind: 'userConfiguration', ...repository, user });
  // `git config --get` exits 1 with no output when the key is unset.
  if (result.code === 1 && !result.bytes.length && !result.diagnostics) {
    return user.xdgConfigHome === null ? join(user.home, '.config', 'git', 'ignore') : join(user.xdgConfigHome, 'git', 'ignore');
  }
  const value = result.bytes.toString('utf8');
  if (result.code !== 0 || !value.endsWith('\n')) throw new WorkspaceFailure('gitConfigurationFailed', { exit: result.code });
  return value.slice(0, -1);
}

/** Lists the untracked paths that Git ignores beneath `rootPath`, a directory of `repository`'s working tree. */
export async function listGitExclusions(supervisor: ProcessSupervisor, executable: string, excludesFile: string | null,
  repository: GitRepositoryLocation, rootPath: string, signal: AbortSignal): Promise<ReadonlySet<string>> {
  const result = await gitProcess(supervisor, executable, rootPath,
    [...excludesArguments(excludesFile), 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], signal,
    { kind: 'diff', ...repository, literalPaths: true, stdin: null });
  if (result.code !== 0) throw new WorkspaceFailure('gitExclusionsFailed', { exit: result.code });
  if (result.diagnostics) {
    process.stderr.write(JSON.stringify({ level: 'warn', event: 'gitExclusionsWarning', rootPath,
      message: result.stderr.toString('utf8').slice(0, 2000) }) + '\n');
  }
  if (result.bytes.length && result.bytes.at(-1) !== 0) throw new WorkspaceFailure('gitProtocolError');
  const paths = new Set<string>(), decoder = new TextDecoder('utf-8', { fatal: true });
  for (let start = 0, end = result.bytes.indexOf(0); end >= 0; start = end + 1, end = result.bytes.indexOf(0, start)) {
    let path: string;
    // A name that is not UTF-8 cannot match a listed path: listing fails for a directory containing one.
    try { path = decoder.decode(result.bytes.subarray(start, end)); } catch { continue; }
    paths.add(path.endsWith('/') ? path.slice(0, -1) : path);
  }
  return paths;
}
