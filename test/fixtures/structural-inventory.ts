import type { InventorySnapshot } from '../../src/contracts/inventory.js';
import type { StructureFile } from '../../src/workspace/structure-index.js';
import { sha256 } from '../../src/workspace/values.js';

/** Synthetic retained syntax for pure queries/presentation; no acquisition or integrity claim. */
export function structuralFile(root: string, path: string, definitions: string[], references: string[]): StructureFile {
  const digest = sha256('');
  return { kind: 'file', root, path, identity: { sha256: digest, byteCount: 0 }, structural: {
    kind: 'artifact', key: { canonicalBase64: '', digest }, record: {
      schemaVersion: 1, keyCanonicalBase64: '', keyDigest: digest, recordSHA256: digest,
      outcome: { kind: 'ready', artifact: { imports: [], exports: [], classes: [], interfaces: [], aliases: [], literalUnions: [],
        functions: [], enums: [], globalVars: [], macros: [], referencedTypes: references } },
      projection: { apiDescription: '', definedTypeNames: definitions },
    },
  } };
}

export function structuralRoots(...names: string[]): InventorySnapshot['roots'] {
  return names.map((name, index) => ({ name, identity: { canonicalPath: '/synthetic/' + name, declaredPath: '/synthetic/' + name,
    device: '1', inode: String(index + 1) } }));
}
