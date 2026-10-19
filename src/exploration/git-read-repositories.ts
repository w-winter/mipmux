import { basename, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { GitRequest } from '../contracts/git.js';
import type { NativeGitCheckout } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { contains, deniedAbsolutePath } from '../workspace/root-policy.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { resolveDiffRepository } from './git-repository.js';

type ReadRequest = Exclude<GitRequest, { op: 'diff' }>;
type Selector = NonNullable<ReadRequest['repositories']>[number];
type Target = { kind: 'explicit'; selector: Selector } | { kind: 'elected'; checkout: NativeGitCheckout };

function describe(operation: WorkspaceOperation, root: string, path: string) {
  return operation.runtime.resolveVCS({ kind: 'resolveCompleteGitTarget', roots: [{ name: root, path }], paths: [path] }, operation.signal);
}

async function resolveDefaultTarget(operation: WorkspaceOperation) {
  for (const root of operation.snapshot.roots) {
    try { return await resolveExplicit(operation, { root: root.name, path: null, worktree: null }); }
    catch (error) {
      if (!(error instanceof WorkspaceFailure && error.code === 'gitQueryFailed' && error.details.reason === 'notRepository')) throw error;
    }
  }
  throw new WorkspaceFailure('gitTargetRequired');
}

async function resolveExplicit(operation: WorkspaceOperation, selector: Selector) {
  const root = operation.snapshot.roots.find(root => root.name === selector.root);
  if (!root) throw new WorkspaceFailure('unknownRoot');
  let location: Parameters<typeof resolveDiffRepository>[2] = { kind: 'explicit', worktree: selector.worktree };
  if (selector.path !== null) {
    const logicalPath = join(root.identity.canonicalPath, selector.path), path = await realpath(logicalPath);
    if (!contains(root.identity.canonicalPath, path) || deniedAbsolutePath(operation.declaration, path, logicalPath)) throw new WorkspaceFailure('pathDenied');
    await operation.validateSourceRoot(root.name);
    const target = await describe(operation, root.name, path);
    if (target.state !== 'available') throw new WorkspaceFailure('gitRepositoryDenied');
    location = selector.worktree === null ? { kind: 'elected', checkout: target.primary }
      : { kind: 'advertised', checkout: target.primary, worktree: selector.worktree };
  }
  if (selector.worktree !== null) {
    const path = await realpath(selector.worktree);
    if (deniedAbsolutePath(operation.declaration, path, path)) throw new WorkspaceFailure('pathDenied');
  }
  const owner = await resolveDiffRepository(operation, root.name, location);
  return { root: root.name, owner,
    pathBase: selector.path === null && selector.worktree === null ? root.identity.canonicalPath : owner.repository.worktree.canonicalPath };
}

async function resolveTarget(operation: WorkspaceOperation, target: Target) {
  if (target.kind === 'explicit') return resolveExplicit(operation, target.selector);
  const owner = await resolveDiffRepository(operation, target.checkout.root, target);
  return { root: target.checkout.root, owner, pathBase: owner.repository.worktree.canonicalPath };
}

async function resolveTargets(operation: WorkspaceOperation, request: ReadRequest, elected: readonly NativeGitCheckout[] | null) {
  const targets: Target[] = [];
  if (elected !== null) targets.push(...elected.map(checkout => ({ kind: 'elected' as const, checkout })));
  else if (request.repositories !== null) targets.push(...request.repositories.map(selector => ({ kind: 'explicit' as const, selector })));
  else return [await resolveDefaultTarget(operation)];
  const resolved = [];
  for (const target of targets) resolved.push(await resolveTarget(operation, target));
  return resolved;
}

export async function resolveReadRepositories(operation: WorkspaceOperation, request: ReadRequest, elected: readonly NativeGitCheckout[] | null) {
  const targets = await resolveTargets(operation, request, elected);
  const repositories = [], seen = new Set<string>();
  for (const target of targets) {
    const { root, owner, pathBase } = target;
    const repoRoot = owner.repository.worktree.canonicalPath, key = repoRoot.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const described = await describe(operation, root, repoRoot);
    if (described.state !== 'available' || await realpath(described.primary.checkoutRootPath) !== repoRoot) throw new WorkspaceFailure('gitRepositoryChanged');
    await owner.revalidate();
    repositories.push({ owner, checkout: described.primary, name: basename(repoRoot), pathBase });
  }
  return repositories;
}
