import { join } from 'node:path';
import type { ProcessSupervisor } from '../runtime/process-supervisor.js';
import { gitProcess, type GitUserConfiguration } from '../patches/git-process.js';
import { WorkspaceFailure } from './values.js';

/** A repository's Git directory and working tree, as canonical paths. */
export interface GitRepositoryLocation { readonly gitDirectory: string; readonly worktree: string }

/** The tracked files beneath a root and the directories containing them, relative to the root. */
export interface TrackedPaths { readonly files: ReadonlySet<string>; readonly directories: ReadonlySet<string> }

/**
 * What a policy needs from Git to apply a repository's exclude files: which excludes file the user's configuration names,
 * and the paths those files cannot exclude because Git tracks them. Asks Git for a root's tracked paths once, when an
 * exclusion first depends on them.
 */
export class GitExcludeQuery {
  readonly #tracked = new Map<string, Promise<TrackedPaths>>();
  readonly #list: (repository: GitRepositoryLocation, rootPath: string) => Promise<TrackedPaths>;
  /** `excludesFile` gives the excludes file Git applies in a repository, or null when no user configuration names one. */
  constructor(readonly excludesFile: (repository: GitRepositoryLocation) => Promise<string | null>,
    list: (repository: GitRepositoryLocation, rootPath: string) => Promise<TrackedPaths>) {
    this.#list = list;
  }
  /** The tracked paths beneath `rootPath`, a directory of `repository`'s working tree. */
  tracked(repository: GitRepositoryLocation, rootPath: string): Promise<TrackedPaths> {
    let paths = this.#tracked.get(rootPath);
    if (!paths) { paths = this.#list(repository, rootPath); this.#tracked.set(rootPath, paths); }
    return paths;
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

/** Lists the tracked files beneath `rootPath`, a directory of `repository`'s working tree, and their directories. */
export async function listTrackedPaths(supervisor: ProcessSupervisor, executable: string, repository: GitRepositoryLocation,
  rootPath: string, signal: AbortSignal): Promise<TrackedPaths> {
  const result = await gitProcess(supervisor, executable, rootPath, ['ls-files', '-z'], signal,
    { kind: 'diff', ...repository, literalPaths: true, stdin: null });
  if (result.code !== 0) throw new WorkspaceFailure('gitTrackedPathsFailed', { exit: result.code });
  if (result.bytes.length && result.bytes.at(-1) !== 0) throw new WorkspaceFailure('gitProtocolError');
  const files = new Set<string>(), directories = new Set<string>(), decoder = new TextDecoder('utf-8', { fatal: true });
  for (let start = 0, end = result.bytes.indexOf(0); end >= 0; start = end + 1, end = result.bytes.indexOf(0, start)) {
    let path: string;
    // A name that is not UTF-8 cannot match a listed path: listing fails for a directory containing one.
    try { path = decoder.decode(result.bytes.subarray(start, end)); } catch { continue; }
    files.add(path);
    for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) directories.add(path.slice(0, slash));
  }
  return { files, directories };
}
