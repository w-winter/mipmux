import { structureValidator, type StructureRequest } from '../contracts/exploration.js';
import type { InventorySnapshot } from '../contracts/inventory.js';
import { StructureIndex } from '../workspace/structure-index.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { pageIdentity, pageOffset } from './continuation.js';
import { pageResult, type ResultEncoding } from './output-budget.js';

export function getCodeStructure(snapshot: InventorySnapshot, request: StructureRequest, encode?: ResultEncoding) {
  if (!structureValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  const seeds = request.seeds.flatMap(seed => {
    const found = snapshot.entries.find(entry => entry.root === seed.root && entry.path === seed.path);
    if (!found || (seed.kind === 'directory' ? found.kind !== 'directory' : found.kind !== 'file' && found.kind !== 'acquisitionFailed')) {
      throw new WorkspaceFailure('unavailableSource', { root: seed.root, path: seed.path });
    }
    return seed.kind === 'file' ? [found] : snapshot.entries.filter(entry =>
      (entry.kind === 'file' || entry.kind === 'acquisitionFailed') && entry.root === seed.root && entry.path.startsWith(seed.path + '/'));
  });
  const expanded = new StructureIndex(snapshot).expand(seeds.filter(seed => seed.kind === 'file'), request.expand, request.depth);
  const records = expanded.files.map(({ file, relationships }) => ({ root: file.root, path: file.path, identity: file.identity,
    outcome: file.structural.kind === 'unsupported' ? { kind: 'unsupported' as const } : file.structural.record.outcome,
    projection: file.structural.kind === 'artifact' ? file.structural.record.projection ?? null : null,
    relationships: relationships,
  }));
  const failures = [...new Map(seeds.filter(seed => seed.kind === 'acquisitionFailed').map(seed => [JSON.stringify([seed.root, seed.path]), seed])).values()]
    .map(file => ({ root: file.root, path: file.path, identity: null,
      outcome: { kind: 'acquisitionFailed' as const, code: file.code }, projection: null, relationships: [] }));
  const complete = [...records, ...failures];
  const { maxOutputBytes, continuation, ...settings } = request;
  const digest = pageIdentity(snapshot, settings, null);
  return pageResult(complete, pageOffset(continuation, digest), maxOutputBytes, (files, next) => ({
    kind: 'structure' as const, inventoryDigest: snapshot.inventoryDigest, approximate: true as const,
    totalFiles: complete.length, files, truncated: next !== null, continuation: next === null ? null : { digest, offset: next },
  }), encode);
}
