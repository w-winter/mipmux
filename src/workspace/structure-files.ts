import type { InventoryEntry, InventorySnapshot } from '../contracts/inventory.js';
import type { NativeStructureInput } from '../contracts/structure.js';
import { structureId } from './structure-identity.js';
import { WorkspaceFailure } from './values.js';

/** Captures the same classified root-local slots for native traversal and native-free accounting. */
export function captureStructureFiles(root: InventorySnapshot['roots'][number], entries: readonly InventoryEntry[]): NativeStructureInput['roots'][number]['files'] {
  return entries.flatMap<NativeStructureInput['roots'][number]['files'][number]>(entry => {
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
}
