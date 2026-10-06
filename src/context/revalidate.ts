import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { Material } from './material-store.js';
import { identity, normalizeRanges } from './material-store.js';
import { prepareText } from '../exploration/lines.js';
import { acquireLocalPatch } from '../patches/local-git.js';
import { descriptorGitMode } from '../contracts/patches.js';
import { canonicalJSON, WorkspaceFailure } from '../workspace/values.js';

export async function revalidateMaterials(
  operation: WorkspaceOperation,
  materials: readonly Material[],
): Promise<void> {
  await operation.validateRoots();
  for (const material of materials) {
    const record = material.record;
    const local = record.kind === 'source'
      ? { source: record.selection.source, identity: record.identity }
      : record.kind === 'document' && record.input.kind === 'localDocument'
      ? { source: record.input.source, identity: record.identity }
      : null;
    if (local) {
      const { source } = local;
      const read = await operation.readSource(source);
      if (
        canonicalJSON(read.identity) !== canonicalJSON(local.identity) ||
        record.kind === 'source' && descriptorGitMode(read.fingerprint.mode) !== record.mode
      ) throw new WorkspaceFailure('sourceChanged', source);
      if (
        record.kind === 'source' && record.selection.kind === 'codemap' &&
        canonicalJSON(read.key) !== canonicalJSON(record.artifactKey)
      ) throw new WorkspaceFailure('pipelineChanged', source);
      if (record.kind === 'source' && record.selection.kind === 'slices') {
        const text = prepareText(read.bytes);
        const normalized = normalizeRanges(record.selection.ranges, text.lines.length);
        const bodies = normalized.map(range =>
          text.lines.slice(range.start - 1, range.end).map(line => line.text).join('')
        );
        if (canonicalJSON(normalized) !== canonicalJSON(record.normalized) ||
          canonicalJSON(bodies) !== canonicalJSON(material.bodies)) throw new WorkspaceFailure('materialChanged');
      }
    }
    if (
      record.kind === 'document' && canonicalJSON(identity(material.bodies.join(''))) !== canonicalJSON(record.identity)
    ) throw new WorkspaceFailure('materialChanged');
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
