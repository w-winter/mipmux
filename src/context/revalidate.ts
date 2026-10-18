import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { Material } from './material-store.js';
import { identity, normalizeRanges } from './material-store.js';
import { prepareText } from '../exploration/lines.js';
import { acquireLocalPatch } from '../patches/local-git.js';
import { descriptorGitMode } from '../contracts/patches.js';
import { canonicalJSON, WorkspaceFailure } from '../workspace/values.js';
import { revalidateGitArtifact } from './git-artifact-material.js';
import type { UnavailableRoot } from '../contracts/context.js';
import { revalidateRootAvailability } from './source-omissions.js';

async function revalidateSource(operation: WorkspaceOperation, record: Extract<Material['record'], { kind: 'source' }>, bodies: readonly string[]): Promise<void> {
  const source = record.selection.source;
  if (record.decoding.kind === 'undecodable') {
    const read = await operation.readRawSource(source);
    if (read.decoding.kind !== 'undecodable' || canonicalJSON(read.key) !== canonicalJSON(record.artifactKey)) {
      throw new WorkspaceFailure('pipelineChanged', source);
    }
    if (descriptorGitMode(read.fingerprint.mode) !== record.mode) throw new WorkspaceFailure('sourceChanged', source);
    return;
  }
  const read = await operation.readSource(source);
  if (canonicalJSON(read.identity) !== canonicalJSON(record.identity) || descriptorGitMode(read.fingerprint.mode) !== record.mode) {
    throw new WorkspaceFailure('sourceChanged', source);
  }
  if (record.selection.kind === 'codemap' && canonicalJSON(read.key) !== canonicalJSON(record.artifactKey)) {
    throw new WorkspaceFailure('pipelineChanged', source);
  }
  if (canonicalJSON(identity(read.text)) !== canonicalJSON(record.decoding.identity)) throw new WorkspaceFailure('pipelineChanged', source);
  if (record.selection.kind === 'slices') {
    const text = prepareText(read.text);
    const normalized = normalizeRanges(record.selection.ranges, text.lines.length);
    const currentBodies = normalized.map(range => text.lines.slice(range.start - 1, range.end).map(line => line.text).join(''));
    if (canonicalJSON(normalized) !== canonicalJSON(record.normalized) || canonicalJSON(currentBodies) !== canonicalJSON(bodies)) {
      throw new WorkspaceFailure('materialChanged');
    }
  }
}
export async function revalidateMaterials(
  operation: WorkspaceOperation,
  materials: readonly Material[],
  unavailableRoots: readonly UnavailableRoot[],
): Promise<void> {
  await revalidateRootAvailability(operation, unavailableRoots);
  for (const material of materials) {
    const record = material.record;
    if (record.kind === 'source') {
      await revalidateSource(operation, record, material.bodies);
      continue;
    }
    if (record.kind === 'document') {
      await revalidateDocument(operation, record, material.bodies);
      continue;
    }
    if (record.kind === 'gitMap' || record.kind === 'gitPatch') {
      if (canonicalJSON(identity(material.bodies.join(''))) !== canonicalJSON(record.identity)) throw new WorkspaceFailure('materialChanged');
      await revalidateGitArtifact(operation, record);
      continue;
    }
    if (record.kind === 'patch') {
      if (canonicalJSON(identity(material.bodies.join(''))) !== canonicalJSON(record.receipt.identity)) {
        throw new WorkspaceFailure('materialChanged');
      }
      for (const control of record.receipt.policies) {
        await operation.authorizeComparisonPath(
          { root: record.receipt.input.root, path: control.path },
          control.policy,
        );
      }
      if (record.receipt.input.kind === 'localPatch') {
        await acquireLocalPatch(operation, record.receipt.input, record.receipt);
      }
    }
  }
}
async function revalidateDocument(operation: WorkspaceOperation, record: Extract<Material['record'], { kind: 'document' }>, bodies: readonly string[]): Promise<void> {
  if ('sourceIdentity' in record) {
    const source = record.input.source;
    const read = await operation.readSource(source);
    if (canonicalJSON(read.identity) !== canonicalJSON(record.sourceIdentity)) throw new WorkspaceFailure('sourceChanged', source);
    if (canonicalJSON(identity(read.text)) !== canonicalJSON(record.identity)) throw new WorkspaceFailure('pipelineChanged', source);
  }
  if (canonicalJSON(identity(bodies.join(''))) !== canonicalJSON(record.identity)) throw new WorkspaceFailure('materialChanged');
}
