import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import type { publishGitSnapshot } from './git-publication.js';
import type { publishGitSnapshotBatch } from './git-publication-batch.js';

type Publication = Awaited<ReturnType<typeof publishGitSnapshot>> | Awaited<ReturnType<typeof publishGitSnapshotBatch>>;

/** Uses the retained primary-artifact decorator for both single and ordered multi-repository replies. */
export async function decorateGitPublicationReply(operation: WorkspaceOperation, published: Publication, autoSelectedPaths: string[],
  readinessWarnings: Record<string, string>) {
  const publications = published.kind === 'single' ? [published] : published.publications;
  const manifests = Object.fromEntries(publications.map(item => {
    const file = item.files.find(file => file.path === 'manifest.json');
    if (!file) throw new WorkspaceFailure('nativeProtocolError');
    return [item.snapshotDir, file.bytes];
  }));
  if (published.kind === 'multiple') {
    const projection = await operation.gitDiffOperation({ kind: 'decorateGitArtifacts', repos: published.projection.reply.repos,
      manifests, autoSelectedPaths, readinessWarnings });
    return { ...published, projection };
  }
  const { op: _op, ...body } = published.projection.reply;
  const projection = await operation.gitDiffOperation({ kind: 'decorateGitArtifacts', repos: [{ ...body,
    repo_root: published.checkout.checkoutRootPath, repo_key: published.checkout.repoKey }],
    manifests, autoSelectedPaths, readinessWarnings });
  const repo = projection.reply.repos[0];
  if (!repo || !('diff' in repo) || !repo.primary_artifacts) throw new WorkspaceFailure('nativeProtocolError');
  const reply = { ...published.projection.reply, primary_artifacts: repo.primary_artifacts };
  if (repo.warning !== undefined) reply.warning = repo.warning;
  return { ...published, projection: { ...published.projection, reply } };
}
