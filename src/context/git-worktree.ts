import type { NativeGitCheckout } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { gitProcess } from '../patches/git-process.js';
import { gitText, resolveDiffRepository } from '../exploration/git-repository.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { resolveGitWorktreeListing, type ReadGitMetadata, type GitWorktreeProjection } from '../exploration/git-worktrees.js';

type Repository = Awaited<ReturnType<typeof resolveDiffRepository>>;
const branchArguments = [['symbolic-ref', '--short', 'HEAD'], ['branch', '--show-current'], ['rev-parse', '--abbrev-ref', 'HEAD']];
const headArguments = ['rev-parse', 'HEAD'];

async function currentBranch(read: ReadGitMetadata, directory: string) {
  for (const args of branchArguments) {
    const branch = await read(directory, args);
    if (branch !== null) return branch;
  }
  return null;
}

export async function captureGitWorktreeReply(operation: WorkspaceOperation, project: GitWorktreeProjection,
  checkout: NativeGitCheckout, repository: Repository, knownMainRoot: string | null, signal: AbortSignal) {
  const read: ReadGitMetadata = async (directory, args) => {
    try {
      const result = await gitProcess(operation.runtime.supervisor, repository.executable, directory, args, signal, { kind: 'repository' });
      if (result.code === 0) return gitText(result.bytes);
      process.stderr.write(JSON.stringify({ level: 'debug', event: 'gitWorktreeMetadataUnavailable',
        repoKey: checkout.repoKey, command: args[0], exit: result.code }) + '\n');
      return null;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof WorkspaceFailure && error.code === 'gitFailed')) throw error;
      process.stderr.write(JSON.stringify({ level: 'debug', event: 'gitWorktreeMetadataUnavailable',
        repoKey: checkout.repoKey, command: args[0], code: error.code }) + '\n');
      return null;
    }
  };
  const repoRoot = checkout.checkoutRootPath;
  const listing = await read(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
  let mainRoot = knownMainRoot;
  if (listing !== null) {
    const projected = await resolveGitWorktreeListing(project, repoRoot, listing, read);
    if (projected.kind === 'gitWorktreeListing') mainRoot = projected.mainRoot ?? knownMainRoot;
    else process.stderr.write(JSON.stringify({ level: 'warning', event: 'gitWorktreeListingUnavailable',
      repoKey: checkout.repoKey, code: projected.kind }) + '\n');
  }
  const branch = await currentBranch(read, repoRoot), head = await read(repoRoot, headArguments);
  let mainBranch: string | null = null, mainHead: string | null = null;
  if (mainRoot !== null) {
    const main = await resolveDiffRepository(operation, checkout.root, { kind: 'explicit', worktree: mainRoot });
    mainBranch = await currentBranch(read, mainRoot); mainHead = await read(mainRoot, headArguments);
    await main.revalidate();
  }
  const projected = await project({ kind: 'renderGitWorktreeReply', repoRoot, rootName: checkout.root,
    mainRoot, branch, head, mainBranch, mainHead });
  await repository.revalidate();
  return { worktree: projected.worktree, warning: projected.warning };
}
