import type { MaterialRecord } from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { CatalogedGitArtifact } from '../workspace/git-artifact-catalog.js';
import { readCatalogedGitArtifact, readAuthorizedGitArtifact } from '../workspace/git-artifact-catalog.js';
import { freeze, canonicalJSON, WorkspaceFailure } from '../workspace/values.js';
import type { SettledMaterial } from './material-store.js';
import { parseSourceBlock } from './source-block.js';

export type SelectedGitArtifact = Extract<MaterialRecord, { kind: 'gitMap' | 'gitPatch' }>;
export type GitArtifactMaterial = SettledMaterial & { readonly record: SelectedGitArtifact };

export async function acquireGitArtifact(operation: WorkspaceOperation, entry: CatalogedGitArtifact): Promise<GitArtifactMaterial> {
  const alias = entry.artifact.clientAlias;
  if (alias === null || entry.artifact.selectionDisposition === 'authorizationDependency') throw new WorkspaceFailure('gitArtifactUnauthorized');
  const body = await readCatalogedGitArtifact(operation, entry);
  const reference = { ownerID: entry.ownerID, checkout: entry.checkout, snapshotID: entry.snapshotID, snapshotDir: entry.snapshotDir,
    path: entry.path, alias, absolutePath: entry.artifact.absolutePath };
  const fields = { id: 'gitArtifact:' + alias, reference, identity: body.identity, spans: [] };
  if (entry.artifact.kind !== 'map') {
    return freeze({ availability: 'settled', record: { ...fields, kind: 'gitPatch' }, bodies: [body.text], sourceBlock: null });
  }
  const record: Extract<MaterialRecord, { kind: 'gitMap' }> = { ...fields, kind: 'gitMap', frame: null };
  const block = await operation.renderFileBlock({ kind: 'renderFileBlock', selectedPath: alias,
    fileName: 'MAP.txt', content: body.text, ranges: null });
  return freeze({ availability: 'settled', record, bodies: [body.text],
    sourceBlock: parseSourceBlock(record, { text: block.text, bodySpans: block.bodySpans }, [body.text], new WorkspaceFailure('invalidSourceBlock')) });
}

export async function revalidateGitArtifact(operation: WorkspaceOperation, record: SelectedGitArtifact) {
  const read = await readAuthorizedGitArtifact(operation, record.reference);
  if (canonicalJSON(read.identity) !== canonicalJSON(record.identity)) throw new WorkspaceFailure('materialChanged');
}
