import type { NativeStructureInput } from '../contracts/structure.js';
import type { StructureFile } from './structure-index.js';
import { resolveStructureEvidence } from './structure-evidence.js';

type Dimension = 'nodes' | 'postings' | 'edges' | 'bytes';
type GraphFile = Pick<NativeStructureInput['roots'][number]['files'][number], 'path' | 'state' | 'definitions' | 'references'>;
type GraphSize = Readonly<Record<Dimension, string>>;
export type GraphRevocation =
  | { readonly kind: 'sizeLimit'; readonly dimension: Dimension; readonly attempted: string; readonly limit: string }
  | { readonly kind: 'accountingOverflow' };
export type StructureResidency =
  | { readonly kind: 'admitted'; readonly size: GraphSize }
  | { readonly kind: 'revoked'; readonly reason: GraphRevocation };

const maximumUInt64 = (1n << 64n) - 1n;
const limits = { nodes: 100000n, postings: 2000000n, edges: 1000000n, bytes: 192n * 1024n * 1024n };
const prices = { nodeOrSlot: 192n, posting: 64n, postingFileID: 16n, postingLedger: 24n,
  evidence: 128n, evidenceLedger: 96n, unresolved: 96n, string: 16n };
const utf8Bytes = (text: string) => BigInt(Buffer.byteLength(text));
const normalized = (names: readonly string[]) => [...new Set(names.map(name => name.normalize('NFC')))];
const stringBytes = (names: readonly string[]) => names.reduce((total, name) => total + utf8Bytes(name) + prices.string, 0n);

/** Applies the source logical retained-size model, including both slot/node and adjacency copies. */
export function evaluateStructureResidency(files: readonly GraphFile[], definitions: ReadonlyMap<string, readonly StructureFile[]>): StructureResidency {
  const size = { nodes: 0n, postings: 0n, edges: 0n, bytes: 0n }, references = new Map<string, bigint>();
  function accountFile(file: GraphFile): void {
    if (file.state === null) return;
    const contributes = file.state === 'contributed' || file.state === 'empty';
    const defined = contributes ? normalized(file.definitions) : [], referenced = contributes ? normalized(file.references) : [];
    const slotBytes = prices.nodeOrSlot + utf8Bytes(file.path) + stringBytes(defined) + stringBytes(referenced);
    size.bytes += slotBytes;
    if (!contributes) return;
    size.nodes++; size.bytes += slotBytes;
    for (const name of referenced) references.set(name, (references.get(name) ?? 0n) + 1n);
    const evidence = resolveStructureEvidence(referenced, definitions);
    size.edges += BigInt(evidence.edges.length);
    for (const edge of evidence.edges) size.bytes += 2n * (prices.evidence + stringBytes(edge.symbols)) + prices.evidenceLedger;
    for (const name of evidence.unresolved) size.bytes += prices.unresolved + utf8Bytes(name);
  }
  for (const file of files) accountFile(file);
  for (const name of new Set([...definitions.keys(), ...references.keys()])) {
    const count = BigInt(definitions.get(name)?.length ?? 0) + (references.get(name) ?? 0n);
    size.postings += count;
    size.bytes += prices.posting + utf8Bytes(name) + count * (prices.postingFileID + prices.postingLedger);
  }
  if (Object.values(size).some(value => value > maximumUInt64)) return { kind: 'revoked', reason: { kind: 'accountingOverflow' } };
  for (const dimension of ['nodes', 'postings', 'edges', 'bytes'] as const) {
    if (size[dimension] > limits[dimension]) return { kind: 'revoked', reason: { kind: 'sizeLimit', dimension,
      attempted: String(size[dimension]), limit: String(limits[dimension]) } };
  }
  return { kind: 'admitted', size: { nodes: String(size.nodes), postings: String(size.postings), edges: String(size.edges), bytes: String(size.bytes) } };
}
