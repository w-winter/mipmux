import type { Static } from 'typebox';
import type { GitRequest } from '../contracts/git.js';
import type { GitSnapshotPublicationOptions } from '../contracts/git-snapshot.js';
import type { GitArtifactRepoReply } from '../contracts/git-artifact.js';
import type { NativeGitCheckout, NativeResult } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { resolveDiffRepository } from '../exploration/git-repository.js';
import { prepareGitDiffComparison, capturePreparedGitDiff } from '../exploration/git-diff.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { failureCode } from '../runtime/tool-result.js';
import { publishGitSnapshot, prepareGitPublicationMetadata } from './git-publication.js';

type DiffRequest = Extract<GitRequest, { op: 'diff' }>;
type Publication = Awaited<ReturnType<typeof publishGitSnapshot>>;
type RepoReply = Static<typeof GitArtifactRepoReply>;
type Plan = Extract<NativeResult, { kind: 'gitPublicationPlan' }>;
type Outcome = { readonly kind: 'published'; readonly publication: Publication; readonly reply: Extract<RepoReply, { diff: object }> }
  | { readonly kind: 'skipped'; readonly reply: Extract<RepoReply, { empty_reason: string }> }
  | { readonly kind: 'failed'; readonly reply: Extract<RepoReply, { error: string }> };

async function publishRepository(operation: WorkspaceOperation, checkout: NativeGitCheckout, plan: Plan['repositories'][number],
  request: DiffRequest, options: GitSnapshotPublicationOptions, ownerID: string, check: () => void): Promise<Outcome> {
  const fields = { repo_root: checkout.checkoutRootPath, repo_key: checkout.repoKey, repo_name: plan.name };
  try {
    check();
    const repository = await resolveDiffRepository(operation, checkout.root, { kind: 'elected', checkout });
    const commands = await prepareGitDiffComparison(operation, request, repository);
    const prepared = await prepareGitPublicationMetadata(operation, checkout, repository);
    const worktree = prepared.worktree.worktree;
    if (plan.emptyReason !== null) {
      const reply: Extract<RepoReply, { empty_reason: string }> = { ...fields, empty_reason: plan.emptyReason };
      if (worktree !== null) reply.worktree = worktree;
      return { kind: 'skipped', reply };
    }
    const captured = await capturePreparedGitDiff(operation, request, repository, commands, options.mode !== 'quick',
      plan.usesSelectedScope ? plan.selectedPaths : null);
    check();
    const publication = await publishGitSnapshot(operation, { ...captured, checkout }, request, options, ownerID, check, prepared);
    const { op: _op, warning: _warning, ...body } = publication.projection.reply;
    return { kind: 'published', publication, reply: { ...fields, ...body } };
  } catch (error) {
    check();
    return { kind: 'failed', reply: { ...fields, error: failureCode(error) } };
  }
}

export async function publishGitSnapshotBatch(operation: WorkspaceOperation, checkouts: readonly NativeGitCheckout[],
  paths: readonly string[], request: DiffRequest, options: GitSnapshotPublicationOptions, ownerID: string, check: () => void) {
  const plan = await operation.projectNative({ kind: 'planGitPublication', repositories: checkouts.map(item => item.checkoutRootPath),
    paths: [...paths], pathspecs: [...(request.path === null ? [] : [request.path]), ...request.paths], scope: options.scope });
  const outcomes: (Outcome | null)[] = checkouts.map(() => null);
  let next = 0;
  const workers = Array.from({ length: Math.min(plan.maxConcurrentRepositories, checkouts.length) }, async () => {
    while (next < checkouts.length) {
      check();
      const index = next++, checkout = checkouts[index], row = plan.repositories[index];
      if (!checkout || !row || checkout.checkoutRootPath !== row.path) throw new WorkspaceFailure('nativeProtocolError');
      const fork = await operation.fork(operation.signal);
      try { outcomes[index] = await publishRepository(fork, checkout, row, request, options, ownerID, check); }
      finally { await fork.close(); }
    }
  });
  const settled = await Promise.allSettled(workers);
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  check();
  const ordered = outcomes.map(item => { if (!item) throw new WorkspaceFailure('nativeProtocolError'); return item; });
  const publications = ordered.flatMap(item => item.kind === 'published' ? [item.publication] : []);
  const manifests = Object.fromEntries(publications.map(item => {
    const file = item.files.find(file => file.path === 'manifest.json');
    if (!file) throw new WorkspaceFailure('nativeProtocolError');
    return [item.snapshotDir, file.bytes];
  }));
  const projection = await operation.projectNative({ kind: 'decorateGitArtifacts', repos: ordered.map(item => item.reply),
    manifests, autoSelectedPaths: [], readinessWarnings: {} });
  check();
  return { kind: 'multiple' as const, publications, projection };
}
