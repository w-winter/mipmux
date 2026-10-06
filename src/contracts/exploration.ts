import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { SourcePath } from './inventory.js';
import { RelativePath, RootName, SafeCount, SHA256 } from './workspace.js';

const closed = { additionalProperties: false };
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const Continuation = Type.Object({ digest: SHA256, offset: SafeCount }, closed);
export type Continuation = Static<typeof Continuation>;
const page = { maxOutputBytes: positive, continuation: Type.Union([Continuation, Type.Null()], { default: null }) };
export const ReadRequest = Type.Object({ root: RootName, path: RelativePath, ...page,
  shape: Type.Union([Type.Object({ kind: Type.Literal('whole') }, closed),
    Type.Object({ kind: Type.Literal('range'), start: positive, end: positive }, closed),
    Type.Object({ kind: Type.Literal('tail'), count: positive }, closed)], { default: { kind: 'whole' } }),
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
  expand: Type.Union([Type.Literal('none'), Type.Literal('uses'), Type.Literal('used_by'), Type.Literal('both')], { default: 'none' }),
  depth: Type.Integer({ minimum: 1, maximum: 4, default: 1 }),
}, closed);
export type StructureRequest = Static<typeof StructureRequest>;
const textQuery = Type.Object({ kind: Type.Union([Type.Literal('literal'), Type.Literal('regex')], { default: 'literal' }), text: Type.String({ minLength: 1 }),
  caseSensitive: Type.Boolean({ default: false }), wholeWord: Type.Boolean({ default: false }) }, closed);
const filters = Type.Object({ roots: Type.Array(RootName, { default: [] }), directories: Type.Array(SourcePath, { default: [] }),
  include: Type.Array(Type.String(), { default: [] }), exclude: Type.Array(Type.String(), { default: [] }), extensions: Type.Array(Type.String(), { default: [] }) }, { ...closed, default: {} });
const search = { ...page, filters, before: Type.Integer({ ...SafeCount, default: 0 }), after: Type.Integer({ ...SafeCount, default: 0 }), countOnly: Type.Boolean({ default: false }) };
export const SearchRequest = Type.Union([
  Type.Object({ ...search, mode: Type.Union([Type.Literal('path'), Type.Literal('content'), Type.Literal('both')], { default: 'content' }), query: textQuery }, closed),
  Type.Object({ ...search, mode: Type.Literal('path', { default: 'path' }), query: Type.Object({ kind: Type.Literal('glob'), text: Type.String({ minLength: 1 }) }, closed) }, closed),
]);
export type SearchRequest = Static<typeof SearchRequest>;
export const readValidator = Compile(ReadRequest), treeValidator = Compile(TreeRequest), structureValidator = Compile(StructureRequest), searchValidator = Compile(SearchRequest);

export const ReadInput = Type.Object({ ...Type.Partial(Type.Omit(ReadRequest, ['root', 'path', 'maxOutputBytes'])).properties,
  root: RootName, path: RelativePath }, closed);
export const StructureInput = Type.Object({ ...Type.Partial(Type.Omit(StructureRequest, ['seeds', 'maxOutputBytes'])).properties,
  seeds: StructureRequest.properties.seeds }, closed);
export const SearchInput = Type.Union([
  Type.Object({ ...Type.Partial(Type.Omit(SearchRequest.anyOf[0], ['query', 'maxOutputBytes'])).properties,
    filters: Type.Optional(Type.Partial(filters, closed)),
    query: Type.Object({ ...Type.Partial(Type.Omit(textQuery, ['text'])).properties, text: textQuery.properties.text }, closed) }, closed),
  Type.Object({ ...Type.Partial(Type.Omit(SearchRequest.anyOf[1], ['maxOutputBytes'])).properties,
    filters: Type.Optional(Type.Partial(filters, closed)), query: SearchRequest.anyOf[1].properties.query }, closed),
]);
export function toolDescription(name: string): string {
  switch (name) {
    case 'get_file_tree': return 'List workspace files. Defaults: files view, unlimited depth, first page. Use selected with an owned draft.';
    case 'read_file': return 'Read a root-qualified file. Example input: {"root":"app","path":"src/main.ts"}. Defaults to the whole file, first page.';
    case 'get_code_structure': return 'Inspect structural maps for file/directory seeds. Defaults: no relationship expansion, depth 1, first page.';
    case 'file_search': return 'Search literal content with case-insensitive substring matching. Example input: {"query":{"text":"greet"}}. Explicit regex/glob kinds are supported; glob defaults to path search. Filters and context are optional.';
    default: return `smip ${name}`;
  }
}
