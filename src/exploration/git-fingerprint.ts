import type { NativeResult } from '../contracts/native.js';
import { gitProcess } from '../patches/git-process.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { gitText, type resolveDiffRepository } from './git-repository.js';

type Repository = Awaited<ReturnType<typeof resolveDiffRepository>>;
type Commands = Extract<NativeResult, { kind: 'gitDiffArguments' }>;

export async function captureGitFingerprint(operation: WorkspaceOperation, owner: Repository, commands: Commands) {
  const run = async (args: string[]) => {
    const result = await gitProcess(operation.runtime.supervisor, owner.executable, owner.repository.worktree.canonicalPath,
      args, operation.signal, { kind: 'repository' });
    if (result.code !== 0) throw new WorkspaceFailure('gitQueryFailed', { exit: result.code });
    return result.bytes;
  };
  const headSHA = gitText(await run(['rev-parse', 'HEAD'])).trim();
  const comparison = commands.comparison;
  const baseRefSHA = comparison.kind === 'unstaged' || comparison.kind === 'revspec' || comparison.base === 'HEAD'
    ? headSHA : gitText(await run(['rev-parse', comparison.base])).trim();
  const status = comparison.kind === 'revspec' ? Buffer.alloc(0) : await run(['status', '--porcelain', '-z', '--untracked-files=all']);
  return (await owner.access.bridge.request({ kind: 'fingerprintGitDiff', root: (await owner.access.openRoot('GitRepository')).handle,
    compare: commands.display, headSHA, baseRefSHA, status: status.toString('base64') }, operation.signal)).result.fingerprint;
}
