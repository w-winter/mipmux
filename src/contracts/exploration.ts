import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { SourcePath } from './inventory.js';
import { RelativePath, RootName, SafeCount, SHA256 } from './workspace.js';

const closed = { additionalProperties: false };
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const Continuation = Type.Object({ digest: SHA256, offset: SafeCount }, closed);
export type Continuation = Static<typeof Continuation>;
const page = { maxOutputBytes: positive, continuation: Type.Union([Continuation, Type.Null()]) };
export const ReadRequest = Type.Object({ root: RootName, path: RelativePath, ...page,
  shape: Type.Union([Type.Object({ kind: Type.Literal('whole') }, closed),
    Type.Object({ kind: Type.Literal('range'), start: positive, end: positive }, closed),
    Type.Object({ kind: Type.Literal('tail'), count: positive }, closed)]),
}, closed);
export type ReadRequest = Static<typeof ReadRequest>;
const selection = Type.Object({ draftId: Type.String({ minLength: 1 }), revision: SafeCount, sources: Type.Array(SourcePath) }, closed);
const tree = { ...page, depth: Type.Union([SafeCount, Type.Null()]) };
export const TreeRequest = Type.Union([
  Type.Object({ ...tree, view: Type.Literal('selected'), selection }, closed),
  Type.Object({ ...tree, view: Type.Enum(['roots', 'files', 'folders']), selection: Type.Union([selection, Type.Null()]) }, closed),
]);
export type TreeRequest = Static<typeof TreeRequest>;
export const StructureRequest = Type.Object({ ...page,
  seeds: Type.Array(Type.Object({ root: RootName, path: RelativePath, kind: Type.Union([Type.Literal('file'), Type.Literal('directory')]) }, closed), { minItems: 1 }),
  expand: Type.Union([Type.Literal('none'), Type.Literal('uses'), Type.Literal('used_by'), Type.Literal('both')]),
  depth: Type.Integer({ minimum: 1, maximum: 4 }),
}, closed);
export type StructureRequest = Static<typeof StructureRequest>;
const textQuery = Type.Object({ kind: Type.Union([Type.Literal('literal'), Type.Literal('regex')]), text: Type.String({ minLength: 1 }),
  caseSensitive: Type.Boolean(), wholeWord: Type.Boolean() }, closed);
const filters = Type.Object({ roots: Type.Array(RootName), directories: Type.Array(SourcePath),
  include: Type.Array(Type.String()), exclude: Type.Array(Type.String()), extensions: Type.Array(Type.String()) }, closed);
const search = { ...page, filters, before: SafeCount, after: SafeCount, countOnly: Type.Boolean() };
export const SearchRequest = Type.Union([
  Type.Object({ ...search, mode: Type.Union([Type.Literal('path'), Type.Literal('content'), Type.Literal('both')]), query: textQuery }, closed),
  Type.Object({ ...search, mode: Type.Literal('path'), query: Type.Object({ kind: Type.Literal('glob'), text: Type.String({ minLength: 1 }) }, closed) }, closed),
]);
export type SearchRequest = Static<typeof SearchRequest>;
export const readValidator = Compile(ReadRequest), treeValidator = Compile(TreeRequest), structureValidator = Compile(StructureRequest), searchValidator = Compile(SearchRequest);
