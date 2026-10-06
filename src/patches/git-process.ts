import type { ProcessSupervisor } from '../runtime/process-supervisor.js';
import { WorkspaceFailure } from '../workspace/values.js';

export async function gitProcess(
  supervisor: ProcessSupervisor,
  executable: string,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  location: { readonly kind: 'repository' } | { readonly kind: 'scratch'; readonly ceiling: string },
) {
  signal.throwIfAborted();
  const child = supervisor.spawn({
    executable,
    cwd,
    args: [
      '--no-pager',
      '--literal-pathspecs',
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
    env: {
      PATH: '/usr/bin:/bin',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ATTR_NOSYSTEM: '1',
      ...(location.kind === 'scratch' ? { GIT_CEILING_DIRECTORIES: location.ceiling } : {}),
    },
  });
  const out: Buffer[] = [];
  let diagnostics = false;
  const abort = () => {
    void child.stop();
  };
  signal.addEventListener('abort', abort, { once: true });
  child.child.stdout.on('data', (bytes: Buffer) => out.push(bytes));
  child.child.stderr.on('data', () => {
    diagnostics = true;
  });
  child.child.stdin.on('error', () => {
    diagnostics = true;
  });
  child.child.stdin.end();
  try {
    const receipt = await child.closed;
    signal.throwIfAborted();
    if (receipt.spawnError || receipt.signal) {
      throw new WorkspaceFailure('gitFailed', { exit: receipt.code, signal: receipt.signal });
    }
    return { bytes: Buffer.concat(out), code: receipt.code, diagnostics };
  } finally {
    signal.removeEventListener('abort', abort);
    await child.stop();
  }
}
