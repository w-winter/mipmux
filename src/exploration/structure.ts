import { structureValidator, type StructureRequest } from '../contracts/exploration.js';
import type { NativeStructureInput } from '../contracts/structure.js';
import type { RootIdentity } from '../contracts/workspace.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { canonicalJSON, sha256, WorkspaceFailure } from '../workspace/values.js';
import { identityEncoding, serializedBytes, type ResultEncoding } from './output-budget.js';

// Headless roots/files have no app UUID. Stable identities retain RPCE's UUID ordering and equality.
function structureId(identity: RootIdentity, path: string | null): string {
  const hex = sha256(canonicalJSON({ identity, path })).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function getCodeStructure(operation: WorkspaceOperation, request: StructureRequest, encode?: ResultEncoding) {
  if (!structureValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  const snapshot = operation.snapshot;
  const roots: NativeStructureInput['roots'] = snapshot.roots.map(root => {
    const files: NativeStructureInput['roots'][number]['files'] = snapshot.entries.flatMap<NativeStructureInput['roots'][number]['files'][number]>(entry => {
      if (entry.root !== root.name || entry.kind !== 'file' && entry.kind !== 'acquisitionFailed' ||
        entry.kind === 'file' && entry.visibility === 'managedOnly') return [];
      const id = structureId(root.identity, entry.path);
      const empty = { id, path: entry.path, definitions: [], references: [], signature: null };
      if (entry.kind === 'acquisitionFailed') {
        const state = entry.structural.kind === 'unsupported' ? null
          : entry.structural.kind === 'pending' ? 'pending' as const : 'terminalExcluded' as const;
        return [{ ...empty, state }];
      }
      if (entry.structural.kind === 'unsupported') return [{ ...empty, state: null }];
      if (entry.structural.kind === 'pending') return [{ ...empty, state: 'pending' as const }];
      const record = entry.structural.record;
      if (record.outcome.kind === 'readyNoSymbols') return [{ ...empty, state: 'empty' as const }];
      if (record.outcome.kind !== 'ready') return [{ ...empty, state: 'terminalArtifact' as const }];
      if (!record.projection) throw new WorkspaceFailure('nativeProtocolError');
      return [{ id, path: entry.path, state: 'contributed' as const, definitions: record.projection.definedTypeNames,
        references: record.outcome.artifact.referencedTypes,
        signature: { imports: record.outcome.artifact.imports, apiDescription: record.projection.apiDescription } }];
    });
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
