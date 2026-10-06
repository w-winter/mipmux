import type { InventorySnapshot, InventoryEntry, SourcePath } from '../contracts/inventory.js';
import { compareBytes, canonicalJSON, WorkspaceFailure } from './values.js';

export type StructureFile = Extract<InventoryEntry, { kind: 'file' }>;
export interface Relationship { readonly root: string; readonly from: string; readonly direction: 'uses' | 'used_by'; readonly type: string; readonly candidates: readonly string[] }
export type Expansion = 'none' | 'uses' | 'used_by' | 'both';
const sourceKey = (file: SourcePath) => canonicalJSON({ root: file.root, path: file.path });
const symbolKey = (root: string, name: string) => canonicalJSON([root, name.normalize('NFC')]);

/** Root-local posting lists retain all syntactic candidates for a name. */
export class StructureIndex {
  readonly #files = new Map<string, StructureFile>();
  readonly #definitions = new Map<string, StructureFile[]>();
  readonly #references = new Map<string, StructureFile[]>();
  constructor(snapshot: InventorySnapshot) {
    for (const entry of snapshot.entries) {
      if (entry.kind !== 'file') continue;
      this.#files.set(sourceKey(entry), entry);
      if (entry.structural.kind !== 'artifact') continue;
      const record = entry.structural.record;
      if (record.outcome.kind !== 'ready' || !record.projection) continue;
      for (const name of new Set(record.projection.definedTypeNames.map(name => name.normalize('NFC')))) {
        const key = symbolKey(entry.root, name), list = this.#definitions.get(key) ?? [];
        list.push(entry); this.#definitions.set(key, list);
      }
      for (const name of new Set(record.outcome.artifact.referencedTypes.map(name => name.normalize('NFC')))) {
        const key = symbolKey(entry.root, name), list = this.#references.get(key) ?? [];
        list.push(entry); this.#references.set(key, list);
      }
    }
  }

  expand(seeds: readonly SourcePath[], expand: Expansion, depth: number) {
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 4) throw new WorkspaceFailure('invalidDepth');
    const visited = new Set<string>();
    let frontier = seeds.map(source => {
      const file = this.#files.get(sourceKey(source));
      if (!file) throw new WorkspaceFailure('unavailableSource', source);
      return file;
    });
    const files: { file: StructureFile; relationships: Relationship[] }[] = [];
    const names = new Set<string>();
    for (let level = 0; frontier.length && level <= (expand === 'none' ? 0 : depth); level++) {
      const next: StructureFile[] = [];
      for (const file of frontier.sort((a, b) => compareBytes(sourceKey(a), sourceKey(b)))) {
        if (visited.has(sourceKey(file))) continue;
        const relationships: Relationship[] = [];
        visited.add(sourceKey(file)); files.push({ file, relationships });
        if (level === depth || expand === 'none' || file.structural.kind !== 'artifact') continue;
        const record = file.structural.record;
        if (record.outcome.kind !== 'ready' || !record.projection) continue;
        const visit = (direction: 'uses' | 'used_by', symbols: readonly string[], index: Map<string, StructureFile[]>) => {
          for (const name of [...new Set(symbols.map(value => value.normalize('NFC')))].sort(compareBytes)) {
            const key = symbolKey(file.root, name), nameVisit = direction + key;
            if (names.has(nameVisit)) continue;
            names.add(nameVisit);
            const candidates = index.get(key) ?? [];
            relationships.push({ root: file.root, from: file.path, direction, type: name, candidates: candidates.map(candidate => candidate.path) });
            next.push(...candidates);
          }
        };
        if (expand === 'uses' || expand === 'both') visit('uses', record.outcome.artifact.referencedTypes, this.#definitions);
        if (expand === 'used_by' || expand === 'both') visit('used_by', record.projection.definedTypeNames, this.#references);
      }
      frontier = next;
    }
    return { files };
  }
}
