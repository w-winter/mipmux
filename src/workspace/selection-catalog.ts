import type { InventorySnapshot } from '../contracts/inventory.js';
import type { NativeOperation } from '../contracts/native.js';

type CatalogRoot = Extract<NativeOperation, { kind: 'prepareSelection' }>['catalog']['roots'][number];

export function selectionCatalogRoots(snapshot: InventorySnapshot,
  bindings: readonly Pick<CatalogRoot, 'id' | 'name' | 'path'>[]): CatalogRoot[] {
  const roots: CatalogRoot[] = bindings.map(root => ({ ...root, files: [], directories: [] }));
  const byName = new Map(roots.map(root => [root.name, root]));
  for (const entry of snapshot.entries) {
    const root = byName.get(entry.root)!;
    if (entry.kind === 'file' || entry.kind === 'acquisitionFailed') {
      root.files.push({ path: entry.path, discoverable: entry.kind === 'acquisitionFailed' || entry.visibility === 'discoverable' });
    } else if (entry.kind === 'directory') {
      root.directories.push({ path: entry.path, discoverable: entry.visibility === 'discoverable' });
    }
  }
  return roots;
}
