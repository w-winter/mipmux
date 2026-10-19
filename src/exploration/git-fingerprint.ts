import type { NativeResult } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { gitText, type resolveDiffRepository } from './git-repository.js';

type Repository = Awaited<ReturnType<typeof resolveDiffRepository>>;
type Commands = Extract<NativeResult, { kind: 'gitDiffArguments' }>;

export async function captureGitFingerprint(operation: WorkspaceOperation, owner: Repository, commands: Commands) {
  const headSHA = gitText(await owner.run(['rev-parse', 'HEAD'])).trim();
  const comparison = commands.comparison;
  const baseRefSHA = comparison.kind === 'unstaged' || comparison.kind === 'revspec' || comparison.base === 'HEAD'
    ? headSHA : gitText(await owner.run(['rev-parse', comparison.base])).trim();
  const status = comparison.kind === 'revspec' ? Buffer.alloc(0) : await owner.run(['status', '--porcelain', '-z', '--untracked-files=all']);
  return (await owner.access.bridge.request({ kind: 'fingerprintGitDiff', root: (await owner.access.openRoot('GitRepository')).handle,
    compare: commands.display, headSHA, baseRefSHA, status: status.toString('base64') }, operation.signal)).result.fingerprint;
}
