import type { NativeOperation } from '../contracts/native.js';
import type { NativeReply } from '../native/bridge-client.js';

type WorktreeOperation = Extract<NativeOperation, { kind: 'prepareGitWorktreeMainRoot' | 'resolveGitWorktreeConfig' | 'projectGitWorktreeListing' }>;
export type GitWorktreeProjection = <O extends WorktreeOperation>(input: O) => Promise<NativeReply<O['kind']>['result']>;
export type ReadGitMetadata = (directory: string, args: readonly string[]) => Promise<string | null>;

export async function resolveGitWorktreeListing(project: GitWorktreeProjection, repoRoot: string,
  listing: string, read: ReadGitMetadata) {
  const prepared = await project({ kind: 'prepareGitWorktreeMainRoot', repoRoot, listing });
  if (prepared.kind === 'gitWorktreeListingError') return prepared;
  let resolved = prepared.mainRoot;
  for (const query of prepared.queries) {
    const config = await read(query.directory, query.arguments);
    if (config === null) continue;
    const candidate = await project({ kind: 'resolveGitWorktreeConfig', repoRoot, config });
    if (candidate.path !== null) { resolved = candidate.path; break; }
  }
  return project({ kind: 'projectGitWorktreeListing', repoRoot, records: prepared.records, mainRoot: resolved });
}
