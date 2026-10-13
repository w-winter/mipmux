import type { ProcessSupervisor } from '../runtime/process-supervisor.js';
import { WorkspaceFailure } from '../workspace/values.js';

export async function gitProcess(
  supervisor: ProcessSupervisor,
  executable: string,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  location: { readonly kind: 'repository' } | { readonly kind: 'scratch'; readonly ceiling: string } |
    { readonly kind: 'diff'; readonly gitDirectory: string; readonly worktree: string;
      readonly literalPaths: boolean; readonly stdin: Buffer | null },
) {
  signal.throwIfAborted();
  const baseEnvironment = {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ATTR_NOSYSTEM: '1',
  };
  const repositoryEnvironment = location.kind === 'diff'
    ? { ...baseEnvironment, GIT_DIR: location.gitDirectory, GIT_WORK_TREE: location.worktree } : baseEnvironment;
  const env = location.kind === 'scratch' ? { ...baseEnvironment, GIT_CEILING_DIRECTORIES: location.ceiling } : repositoryEnvironment;
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
