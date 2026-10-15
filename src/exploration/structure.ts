import { structureValidator, type StructureRequest } from '../contracts/exploration.js';
import type { NativeStructureInput } from '../contracts/structure.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { structureId } from '../workspace/structure-identity.js';
import { captureStructureFiles } from '../workspace/structure-files.js';
import { identityEncoding, serializedBytes, type ResultEncoding } from './output-budget.js';

export async function getCodeStructure(operation: WorkspaceOperation, request: StructureRequest, encode?: ResultEncoding) {
  if (!structureValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  const snapshot = operation.snapshot;
  const roots: NativeStructureInput['roots'] = snapshot.roots.map(root => {
    const files = captureStructureFiles(root, snapshot.entries);
    const complete = snapshot.enumeration.kind === 'complete' || !snapshot.enumeration.failures.some(failure => failure.root === root.name);
    return { id: structureId(root.identity, null), name: root.name, canonicalPath: root.identity.canonicalPath, complete, files,
      directories: snapshot.entries.filter(entry => entry.root === root.name && entry.kind === 'directory' && entry.visibility === 'discoverable').map(entry => entry.path) };
  });
  const selectors: NativeStructureInput['seedInput']['selectors'] = request.seeds === null
    ? (request.selection?.sources ?? []).map(source => ({ ...source, kind: 'file' as const }))
    : request.seeds.map(seed => seed.kind === 'file' ? seed : { root: seed.root, kind: 'directory' as const,
      path: seed.directory.kind === 'root' ? '' : seed.directory.path });
  const seedInput: NativeStructureInput['seedInput'] = request.seeds === null
    ? { kind: 'selected', selectors } : { kind: 'paths', selectors };
  const result = await operation.queryStructure({ kind: 'queryStructure', inventoryDigest: snapshot.inventoryDigest,
    roots, seedInput, expand: request.expand, depth: request.depth, signatures: request.signatures, size: request.size });
  // Semantic size limits are applied by the source query. Transport admission never omits graph evidence.
  const reply = { kind: 'structure' as const, inventoryDigest: snapshot.inventoryDigest, ...result.reply, text: result.text };
  const requiredBytes = serializedBytes((encode ?? identityEncoding)(reply));
  return requiredBytes <= request.maxOutputBytes ? reply : { kind: 'outputBudgetTooSmall' as const, requiredBytes };
}
