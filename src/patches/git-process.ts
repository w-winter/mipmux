import type { ProcessSupervisor } from '../runtime/process-supervisor.js';
import { WorkspaceFailure } from '../workspace/values.js';

/** Where Git finds the user's global configuration: `~/.gitconfig` and the `git` directory under `xdgConfigHome` or `~/.config`. */
export interface GitUserConfiguration { readonly home: string; readonly xdgConfigHome: string | null }

function gitEnvironment(base: Record<string, string>, location: Parameters<typeof gitProcess>[5]) {
  const isolated = { ...base, GIT_CONFIG_GLOBAL: '/dev/null' };
  switch (location.kind) {
    case 'repository': return isolated;
    case 'scratch': return { ...isolated, GIT_CEILING_DIRECTORIES: location.ceiling };
    case 'diff': return { ...isolated, GIT_DIR: location.gitDirectory, GIT_WORK_TREE: location.worktree };
    case 'userConfiguration': {
      const { home, xdgConfigHome } = location.user;
      const environment = { ...base, HOME: home, GIT_DIR: location.gitDirectory, GIT_WORK_TREE: location.worktree };
      return xdgConfigHome === null ? environment : { ...environment, XDG_CONFIG_HOME: xdgConfigHome };
    }
  }
}

export async function gitProcess(
  supervisor: ProcessSupervisor,
  executable: string,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  location: { readonly kind: 'repository' } | { readonly kind: 'scratch'; readonly ceiling: string } |
    { readonly kind: 'diff'; readonly gitDirectory: string; readonly worktree: string;
      readonly literalPaths: boolean; readonly stdin: Buffer | null } |
    // Reads the user's global configuration as well as the repository's; every other location reads only the repository's.
    { readonly kind: 'userConfiguration'; readonly gitDirectory: string; readonly worktree: string; readonly user: GitUserConfiguration },
) {
  signal.throwIfAborted();
  const baseEnvironment = {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ATTR_NOSYSTEM: '1',
  };
  const env = gitEnvironment(baseEnvironment, location);
  const child = supervisor.spawn({
    executable,
    cwd,
    args: [
      '--no-pager',
      ...(location.kind === 'diff' && !location.literalPaths ? [] : ['--literal-pathspecs']),
      '--no-replace-objects',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'core.quotePath=true',
      '-c',
      'core.fileMode=true',
      '-c',
      'protocol.allow=never',
      ...args,
    ],
    env,
  });
  const out: Buffer[] = [];
  let diagnostics = false;
  const stderr: Buffer[] = [];
  const abort = () => {
    void child.stop();
  };
  signal.addEventListener('abort', abort, { once: true });
  child.child.stdout.on('data', (bytes: Buffer) => out.push(bytes));
  child.child.stderr.on('data', (bytes: Buffer) => {
    diagnostics = true;
    stderr.push(bytes);
  });
  child.child.stdin.on('error', () => {
    diagnostics = true;
  });
  child.child.stdin.end(location.kind === 'diff' ? location.stdin : undefined);
  try {
    const receipt = await child.closed;
    signal.throwIfAborted();
    if (receipt.spawnError || receipt.signal) {
      throw new WorkspaceFailure('gitFailed', { exit: receipt.code, signal: receipt.signal });
    }
    return { bytes: Buffer.concat(out), code: receipt.code, diagnostics, stderr: Buffer.concat(stderr) };
  } finally {
    signal.removeEventListener('abort', abort);
    await child.stop();
  }
}
