import Type, { type Static } from 'typebox';
import { askUserDescription } from './interaction.js';
import { Compile } from 'typebox/compile';
import { SourcePath } from './inventory.js';
import { NativeReadArgument } from './native.js';
import { SearchPatternKind, SearchMode } from './search-pattern.js';
import { DirectoryRef, RelativePath, RootName, SafeCount, SHA256 } from './workspace.js';

const closed = { additionalProperties: false };
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const Continuation = Type.Object({ digest: SHA256, offset: SafeCount }, closed);
export type Continuation = Static<typeof Continuation>;
const page = { maxOutputBytes: positive, continuation: Type.Union([Continuation, Type.Null()], { default: null }) };
const readOptions = { ...page,
  start_line: Type.Union(NativeReadArgument.anyOf, { default: null }),
  offset: Type.Union(NativeReadArgument.anyOf, { default: null }),
  limit: Type.Union(NativeReadArgument.anyOf, { default: null }),
};
export const ReadRequest = Type.Union([
  Type.Object({ root: RootName, path: RelativePath, ...readOptions }, closed),
  Type.Object({ root: Type.Null({ default: null }), path: RelativePath, ...readOptions }, closed),
]);
export type ReadRequest = Static<typeof ReadRequest>;
const selection = Type.Object({ draftId: Type.String({ minLength: 1 }), revision: SafeCount, sources: Type.Array(SourcePath) }, closed);
const treeScope = Type.Union([Type.Object({ root: RootName, directory: DirectoryRef }, closed), Type.Null()], { default: null });
const tree = { ...page, type: Type.Literal('files', { default: 'files' }),
  mode: Type.Enum(['auto', 'full', 'folders', 'selected'], { default: 'auto' }), scope: treeScope,
  maxDepth: Type.Union([Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()], { default: null }) };
export const TreeRequest = Type.Union([
  Type.Object({ ...page, type: Type.Literal('roots'), selection: Type.Null() }, closed),
  Type.Object({ ...tree, selection: Type.Union([selection, Type.Null()]) }, closed),
]);
export type TreeRequest = Static<typeof TreeRequest>;
export const StructureRequest = Type.Object({ maxOutputBytes: positive,
  seeds: Type.Union([Type.Array(Type.Union([
    Type.Object({ root: RootName, path: RelativePath, kind: Type.Literal('file') }, closed),
    Type.Object({ root: RootName, directory: DirectoryRef, kind: Type.Literal('directory') }, closed),
  ]), { minItems: 1, maxItems: 256 }), Type.Null()], { default: null }),
  selection: Type.Union([selection, Type.Null()], { default: null }),
  expand: Type.Union([Type.Literal('none'), Type.Literal('uses'), Type.Literal('used_by'), Type.Literal('both')], { default: 'none' }),
  depth: Type.Integer({ minimum: 1, maximum: 4, default: 1 }),
  signatures: Type.Boolean({ default: true }), size: Type.Enum(['small', 'medium', 'large'], { default: 'medium' }),
}, closed);
export type StructureRequest = Static<typeof StructureRequest>;
const textQuery = Type.Object({ kind: SearchPatternKind, text: Type.String({ minLength: 1 }),
  caseSensitive: Type.Boolean({ default: false }), wholeWord: Type.Boolean({ default: false }) }, closed);
const filters = Type.Object({ roots: Type.Array(RootName, { default: [] }), paths: Type.Array(Type.String(), { default: [] }),
  exclude: Type.Array(Type.String(), { default: [] }), extensions: Type.Array(Type.String(), { default: [] }) }, { ...closed, default: {} });
const search = { ...page, filters, before: Type.Integer({ ...SafeCount, default: 0 }), after: Type.Integer({ ...SafeCount, default: 0 }), countOnly: Type.Boolean({ default: false }),
  maxResults: Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, default: 50 }) };
export const SearchRequest = Type.Union([
  Type.Object({ ...search, mode: SearchMode, query: textQuery }, closed),
  Type.Object({ ...search, mode: Type.Literal('path', { default: 'path' }), query: Type.Object({ kind: Type.Literal('glob'), text: Type.String({ minLength: 1 }),
    caseSensitive: Type.Boolean({ default: false }) }, closed) }, closed),
]);
export type SearchRequest = Static<typeof SearchRequest>;
export const readValidator = Compile(ReadRequest), treeValidator = Compile(TreeRequest), structureValidator = Compile(StructureRequest), searchValidator = Compile(SearchRequest);

export const ReadInput = Type.Union([
  Type.Object({ ...Type.Partial(Type.Omit(ReadRequest.anyOf[0], ['root', 'path', 'maxOutputBytes'])).properties,
    root: RootName, path: RelativePath }, closed),
  Type.Object({ ...Type.Partial(Type.Omit(ReadRequest.anyOf[1], ['path', 'maxOutputBytes'])).properties,
    path: RelativePath }, closed),
]);
export const ScopedStructure = Type.Omit(StructureRequest, ['selection']);
export const StructureInput = Type.Object({ ...Type.Partial(Type.Omit(ScopedStructure, ['maxOutputBytes', 'seeds'])).properties,
  seeds: Type.Optional(StructureRequest.properties.seeds.anyOf[0]) }, closed);
export const SearchInput = Type.Union([
  Type.Object({ ...Type.Partial(Type.Omit(SearchRequest.anyOf[0], ['query', 'maxOutputBytes'])).properties,
    filters: Type.Optional(Type.Partial(filters, closed)),
    query: Type.Object({ ...Type.Partial(Type.Omit(textQuery, ['text'])).properties, text: textQuery.properties.text }, closed) }, closed),
  Type.Object({ ...Type.Partial(Type.Omit(SearchRequest.anyOf[1], ['maxOutputBytes'])).properties,
    filters: Type.Optional(Type.Partial(filters, closed)), query: Type.Object({
      ...SearchRequest.anyOf[1].properties.query.properties,
      caseSensitive: Type.Optional(SearchRequest.anyOf[1].properties.query.properties.caseSensitive),
    }, closed) }, closed),
]);
export function toolDescription(name: string): string {
  switch (name) {
    case 'ask_user': return askUserDescription;
    case 'draft_dispose': return 'Dispose an owned manual draft. Joins its work and deletes Git snapshots whose current manifest names that draft, then forgets the draft capability. Returns deletedSnapshots. Saved packets and snapshots owned by other contexts remain available. Normal finalization and connection shutdown retain snapshots.';
    case 'context_builder_dispose': return 'Dispose an owned context-builder job. Cancels discovery or waits for an in-progress publication to settle, then deletes Git snapshots whose current manifest names its draft. Returns deletedSnapshots. Terminal job receipts, request-id deduplication and saved packets remain available. Repeated disposal returns zero after cleanup. Normal completion and connection shutdown retain snapshots.';
    case 'get_file_tree': return 'Render the RPCE file tree. type=roots lists physical roots; type=files uses mode=auto, full, folders or selected. Defaults: files, auto mode, whole workspace, unlimited requested depth, first page. scope identifies a root and a root/descendant directory. maxDepth uses folder depth starting at zero and retains selected descendants. Selected mode requires an owned draft. Output pages preserve complete rendered lines; follow continuation for the remaining tree.';
    case 'git': return 'Inspect a declared root’s owning Git checkout with op=status, log, show, blame or diff. Log defaults to ten commits; log/blame paths are root-relative. Show accepts ref and summary/files/full detail. Diff defaults to uncommitted/summary, three context lines and detectRenames=false; compare also accepts staged, unstaged, base/merge-base forms, back:N, revision ranges and main/trunk. Diff path and paths are checkout-relative Git pathspecs; absolute paths are literal. One path upgrades summary to patches. Patches use a 300-line allowance; full retains complete hunks. Diff includes applicable untracked files and reports protected endpoints in exclusions. Optional worktree selects a freshly verified advertised same-repository checkout. With an owned draft, artifacts=true publishes snapshots and adds mutable MAP/whole-patch selection. Options: mode=quick/standard/deep, scope=all/selected, snapshot_id and inline={map,mode,max_lines}. Per-file aliases are advertised for manage_selection. Publication and selection effects remain after failed reply admission; use manage_selection get to recover state. Ordinary file tools remain declared-root scoped. Git configuration must be trusted because clean/process filters may execute programs. The complete reply must fit maxOutputBytes.';
    case 'read_file': return 'Read a root-qualified source file, or omit root to read an exact selected _git_data/... artifact alias from the owning draft. MCP artifact reads require draftId. Advertised per-file patches must be selected before reading; selected historical artifacts remain readable after publication grants change. Defaults to the whole file, first page. start_line is one-based; a negative start reads the last N lines and cannot be combined with limit. limit=0 returns no lines; a negative limit reads the remainder. Starts beyond EOF return empty content with a message. offset is the current start_line alias. Numeric strings are accepted; an integer offset takes priority over a string start_line. Complete line records retain CRLF, CR and LF; continuations never split a line.';
    case 'get_code_structure': return 'Inspect source-backed graph evidence and signatures. Omit seeds to inspect current selected full/sliced sources; MCP callers supply an owned draftId for that selection. Explicit seeds accept up to 256 file or directory selectors. Directory selectors use directory={kind:root} or {kind:descendant,path}. Defaults: no expansion, depth 1, signatures=true, size=medium. expand=uses, used_by or both traverses root-local relationships at depths 1-4. size=small, medium or large controls graph and signature limits; signatures=false returns graph evidence alone. Results include seed/index states, canonical edges, unresolved names and partial-output diagnostics. maxOutputBytes admits the complete reply; use a narrower query or larger cap when it cannot fit.';
    case 'file_search': return 'Search paths/content with mode=auto (default), path, content or both. Example: {"query":{"text":"greet"}}. Auto mode uses RPCE pattern rules; omitted query.kind infers regex syntax. Explicit literal/regex kinds select interpretation; glob selects path mode. Matching is case-insensitive by default, including globs. Text patterns are trimmed. Literal content spaces match flexible whitespace and bypass wholeWord. Path candidates include relative and root-alias paths. maxResults defaults to 50 per stage; nonpositive values collect no results. Count-only scans all content matches and retains the path limit. maxOutputBytes pages the limited result set. filters.paths accepts raw file/folder paths, root aliases, absolute paths and wildcards as an OR scope. Missing paths use RPCE prefix recovery; ambiguous scopes return a diagnostic. New searches reconcile the catalog; continuations stay generation-bound. Replies report scopedFileCount, enumeration coverage, unavailableRoots and per-file limitations. filters.extensions uses exact dotted names such as .swift; exclusions use case-insensitive substring or native wildcard matching. Filters apply before result limits. Context is optional.';
    case 'prompt': return 'Get the current literal prompt, replace it with op=set and text, append exact text with op=append, or clear with op=clear. Mutations require expectedRevision; get does not. Augment preserves original text at the start; Preserve leaves it unchanged. The resulting prompt is delivered verbatim in user_instructions.';
    case 'manage_selection': return 'Inspect or change selection using op=get, set, add, remove, preview, promote, demote or clear. Defaults: get, mode=full, strict=false, view=summary and relative path display. Views: summary, files, content, codemaps. paths accepts file/directory names, root aliases and absolute paths within declared roots; slices accepts described ranges or terminal #L ranges. Full add preserves existing slices; promote expands a file to full content. Codemap-only add and demote enter manual mode; promote preserves mode. Full removal retains manual codemaps. Set rejects invalid inputs; preview does not commit selection. Explicit file registration remains workspace-owned and can survive a rejected selection. Mutations check the owning revision before selection commits. Selection commits before reply rendering and maxOutputBytes admission; later cancellation or reply failure retains the committed state. Use get or draft_inspect to recover current state after a missing or failed reply.';
    case 'draft_preview': return 'Prepare an ordered source edit batch at expectedRevision without committing it. Returns candidate metadata, costs, diagnostics and complete-packet measurement at the unchanged revision. Required source constraints, cancellation and response caps apply.';
    case 'draft_update': return 'Mutate at expectedRevision: upsert/remove source, slice add/setPaths/remove, clearCodemaps, clearSources, prompt, addDocument, or an atomic source edit batch. A batch applies edits in order, derives inferred codemaps from the final state and commits one revision; failed preparation or receipt admission commits nothing. Full/slices preserve mode; codemap upserts enter manual mode. Removing explicit source may leave an inferred codemap; inferred-only removal is a no-op. clearCodemaps enters manual mode and removes optional codemaps; clearSources restores required sources and their initial mode. Both retain documents, patches and prompt. For unavailable inferred targets or inferred comparison mismatches, use clearCodemaps and add admissible codemaps with target evidence. Added documents are complete immutable suppliedDocument text with unique id, role and origin.';
    default: return `smip ${name}`;
  }
}
