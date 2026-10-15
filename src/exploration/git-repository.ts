import { realpath } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { RelativePath } from '../contracts/workspace.js';
import { directoryIdentity } from '../patches/local-git.js';
import { gitProcess } from '../patches/git-process.js';
import { contains, deniedAbsolutePath } from '../workspace/root-policy.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { canonicalJSON, WorkspaceFailure } from '../workspace/values.js';
import type { NativeGitCheckout } from '../contracts/native.js';
import { resolveGitWorktreeListing, type ReadGitMetadata } from './git-worktrees.js';

const pathValidator = Compile(RelativePath);
export function gitText(bytes: Buffer): string {
  if (!isUtf8(bytes)) throw new WorkspaceFailure('gitOutputUndecodable');
  return bytes.toString('utf8');
}

/** Resolves a loaded checkout or an advertised worktree, then fences its captured identities. */
export async function resolveDiffRepository(operation: WorkspaceOperation, rootName: string,
  location: { kind: 'explicit'; worktree: string | null } | { kind: 'elected'; checkout: NativeGitCheckout }) {
  const configured = operation.runtime.options.git;
  if (!configured) throw new WorkspaceFailure('gitNotConfigured');
  const root = operation.snapshot.roots.find(root => root.name === rootName);
  if (!root) throw new WorkspaceFailure('unknownRoot');
  await operation.validateSourceRoots();
  const run = async (cwd: string, args: readonly string[]) => {
    const result = await gitProcess(operation.runtime.supervisor, configured.executable, cwd, args, operation.signal, { kind: 'repository' });
    if (result.code !== 0) throw new WorkspaceFailure('gitQueryFailed', { exit: result.code });
    return result.bytes;
  };
  const identify = async (cwd: string) => {
    const identity = async (args: readonly string[]) => {
      const text = gitText(await run(cwd, args));
      if (!text.endsWith('\n')) throw new WorkspaceFailure('gitProtocolError');
      return directoryIdentity(text.slice(0, -1));
    };
    return { worktree: await identity(['rev-parse', '--show-toplevel']), gitDirectory: await identity(['rev-parse', '--absolute-git-dir']),
      commonDirectory: await identity(['rev-parse', '--path-format=absolute', '--git-common-dir']) };
  };
  const anchorPath = location.kind === 'elected' ? location.checkout.checkoutRootPath : root.identity.canonicalPath;
  const worktree = location.kind === 'explicit' ? location.worktree : null;
  const anchor = await identify(anchorPath);
  const advertisedWorktrees = async () => {
    const listing = gitText(await run(anchor.worktree.canonicalPath, ['worktree', 'list', '--porcelain', '-z']));
    const read: ReadGitMetadata = async (directory, args) => {
      try { return gitText(await run(directory, args)); }
      catch (error) {
        operation.signal.throwIfAborted();
        if (!(error instanceof WorkspaceFailure && ['gitQueryFailed', 'gitFailed'].includes(error.code))) throw error;
        return null;
      }
    };
    const projected = await resolveGitWorktreeListing(input => operation.gitDiffOperation(input),
      anchor.worktree.canonicalPath, listing, read);
    if (projected.kind === 'gitWorktreeListingError') throw new WorkspaceFailure('gitProtocolError', { message: projected.message });
    return Promise.all(projected.paths.map(path => realpath(path)));
  };
  let repository = anchor;
  if (worktree !== null) {
    const path = await realpath(worktree);
    const advertised = await advertisedWorktrees();
    const loaded = operation.snapshot.roots.some(root => contains(root.identity.canonicalPath, path));
    const advertisingCheckoutLoaded = advertised.some(path => operation.snapshot.roots.some(root => contains(root.identity.canonicalPath, path)));
    if (!advertised.includes(path) || !loaded && !advertisingCheckoutLoaded) throw new WorkspaceFailure('gitRepositoryDenied');
    repository = await identify(path);
    if (repository.worktree.canonicalPath !== path || canonicalJSON(repository.commonDirectory) !== canonicalJSON(anchor.commonDirectory)) {
      throw new WorkspaceFailure('gitRepositoryDenied');
    }
  }
  const access = await operation.openGitSourceAccess(repository.worktree);
  const permits = (path: string) => {
    if (!pathValidator.Check(path)) throw new WorkspaceFailure('gitProtocolError');
    return !deniedAbsolutePath(operation.declaration, join(repository.worktree.canonicalPath, path), join(anchor.worktree.canonicalPath, path));
  };
  const revalidate = async () => {
    if (canonicalJSON(await identify(anchorPath)) !== canonicalJSON(anchor) ||
        canonicalJSON(await identify(repository.worktree.canonicalPath)) !== canonicalJSON(repository)) throw new WorkspaceFailure('gitRepositoryChanged');
    if (worktree !== null) {
      const listed = await advertisedWorktrees();
      if (!listed.includes(repository.worktree.canonicalPath)) throw new WorkspaceFailure('gitRepositoryChanged');
    }
  };
  return { executable: configured.executable, repository, access, permits, revalidate };
}
