import Type, { type Static } from 'typebox';
import { RootName, RelativePath, SafeCount, SHA256 } from './workspace.js';

const closed = { additionalProperties: false };
const status = Type.Enum(['ok', 'partial', 'pending', 'unavailable']);
const issue = Type.Object({ code: Type.String(), phase: Type.String(), path: Type.Optional(Type.String()),
  retryable: Type.Boolean(), retry_after_ms: Type.Optional(SafeCount), attempted: Type.Optional(SafeCount),
  limit: Type.Optional(SafeCount), message: Type.String() }, closed);
const reach = Type.Array(Type.Enum(['uses', 'used_by']));
export const StructureReply = Type.Object({ status, size: Type.Enum(['small', 'medium', 'large']),
  roots: Type.Array(Type.Object({ root: RootName, status,
    index: Type.Object({ state: Type.Enum(['complete', 'indexing']), indexed: SafeCount, total: SafeCount }, closed),
    updates_pending: Type.Optional(Type.Boolean()),
    seeds: Type.Array(Type.Object({ path: Type.String(), state: Type.Enum(['covered', 'pending', 'not_indexed', 'excluded']) }, closed)),
    nodes: Type.Array(Type.Object({ path: Type.String(), depth: SafeCount, seed: Type.Optional(Type.Boolean()), reached_by: reach }, closed)),
    edges: Type.Array(Type.Object({ from: Type.String(), to: Type.String(), symbols: Type.Array(Type.String()), ambiguous: Type.Optional(Type.Boolean()) }, closed)),
    unresolved: Type.Array(Type.Object({ from: Type.String(), name: Type.String(), reason: Type.Enum(['missing', 'not_indexed_yet', 'too_common']) }, closed)),
    truncated: Type.Optional(Type.Object({ reason: Type.Literal('size'), dropped_nodes: SafeCount }, closed)), issues: Type.Array(issue),
  }, closed)),
  files: Type.Array(Type.Object({ path: Type.String(), role: Type.Enum(['seed', 'related']), depth: SafeCount,
    reached_by: reach, content: Type.String(), tokens: SafeCount }, closed)),
  summary: Type.Object({ seeds: SafeCount, nodes: SafeCount, edges: SafeCount, files: SafeCount, tokens: SafeCount }, closed),
  issues: Type.Array(issue), retry: Type.Optional(Type.Object({ retryable: Type.Boolean(), retry_after_ms: Type.Optional(SafeCount) }, closed)),
}, closed);
export type StructureReply = Static<typeof StructureReply>;
export const StructureToolResult = Type.Object({ ...StructureReply.properties, kind: Type.Literal('structure'),
  inventoryDigest: SHA256, text: Type.String() }, closed);
const selector = Type.Union([
  Type.Object({ kind: Type.Literal('file'), root: RootName, path: RelativePath }, closed),
  Type.Object({ kind: Type.Literal('directory'), root: RootName, path: Type.Union([RelativePath, Type.Literal('')]) }, closed),
]);
const uuid = Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' });
export const NativeStructureInput = Type.Object({ kind: Type.Literal('queryStructure'), inventoryDigest: SHA256,
  codeMapsGloballyDisabled: Type.Boolean(),
  roots: Type.Array(Type.Object({ id: uuid, name: RootName, canonicalPath: Type.String({ pattern: '^/[^\\u0000]*$' }),
    complete: Type.Boolean(), directories: Type.Array(RelativePath),
    files: Type.Array(Type.Object({ id: uuid, path: RelativePath,
      state: Type.Union([Type.Enum(['pending', 'contributed', 'empty', 'terminalArtifact', 'terminalExcluded']), Type.Null()]),
      definitions: Type.Array(Type.String()), references: Type.Array(Type.String()),
      signature: Type.Union([Type.Object({ imports: Type.Array(Type.String()), apiDescription: Type.String() }, closed), Type.Null()]),
    }, closed)),
  }, closed)),
  seedInput: Type.Union([
    Type.Object({ kind: Type.Literal('paths'), selectors: Type.Array(selector, { minItems: 1, maxItems: 256 }) }, closed),
    Type.Object({ kind: Type.Literal('selected'), selectors: Type.Array(selector) }, closed),
  ]),
  expand: Type.Enum(['none', 'uses', 'used_by', 'both']), depth: Type.Integer({ minimum: 1, maximum: 4 }),
  signatures: Type.Boolean(), size: Type.Enum(['small', 'medium', 'large']),
}, closed);
export type NativeStructureInput = Static<typeof NativeStructureInput>;
export const NativeStructureResult = Type.Object({ kind: Type.Literal('structure'), reply: StructureReply, text: Type.String() }, closed);
