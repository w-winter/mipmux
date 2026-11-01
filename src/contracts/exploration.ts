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
    case 'workspace_declare': return 'Declare a workspace for the exploration and manual-draft tools. spec names absolute roots, exclusions ({kind:prefix,root,path} or {kind:glob,root,pattern}) and an existing output root, which is never indexed. Returns {kind:workspace,id}, which those tools take; context_builder and context_prepare take the declaration itself instead. Declaring the same spec again reuses the open workspace and its index. If a later call returns unknownWorkspace, the server restarted: declare the same spec again.';
    case 'workspace_refresh': return 'Rescan the declared roots and return the inventory snapshot, which lists every entry in the workspace. Other calls refresh before they run, so ordinary workflows never need this.';
    case 'workspace_close': return 'Release an owned workspace id. Drafts that use the workspace finish their work; later calls with the id return unknownWorkspace.';
    case 'draft_create': return 'Create a manual draft in a declared workspace from a full context request, without discovery. Reconciles the workspace and acquires required sources, then returns {kind:draft,id,revision}. Edit it with manage_selection, prompt and draft_update, check it with draft_inspect and draft_validate, and publish it with draft_finalize.';
    case 'draft_inspect': return 'Inspect an owned draft, manual or left by a blocked job. view=metadata describes the draft and its selection; view=costs measures each material against the budget; view=material with materialId shows one material. Pages with continuation.';
    case 'draft_validate': return 'Check an owned draft as draft_finalize would, without publishing: verifies required material against current files, renders the packet and returns per-material costs, diagnostics and the revision checked. Costs page with continuation.';
    case 'draft_dispose': return 'Dispose an owned manual draft. Joins its work and deletes Git snapshots whose current manifest names that draft, then forgets the draft capability. Returns deletedSnapshots. Saved packets and snapshots owned by other contexts remain available. Normal finalization and connection shutdown retain snapshots.';
    case 'context_builder': return 'Start Context Builder: a discovery agent selects the files, code maps and Git patches a task needs, and mipmux publishes them as a verified packet in outputRoot/outputName. Returns a job snapshot at once; follow it with context_job wait. workspace names absolute roots and an existing output folder, which is never indexed; the server keeps the index of a declaration for the connection. task is the whole request. required lists files that must appear, whole or as line ranges; patches lists complete local Git comparisons by ref; documents carries text from outside the roots. copyPreset defaults to codeReview for a review or any patch, otherwise standard; omitted budgetUnits and enhancementMode use the host defaults. discovery selects the discovery model, as provider/model from the server\'s allowed list, and its thinking level; set it only when the user names one. clarification lets discovery ask questions and needs form elicitation. Repeating a start returns the same job. The same outputName with a different request or workspace fails with outputNameConflict, and a name already present in the output folder fails the job with alreadyExists before discovery; a new attempt needs a new outputName.';
    case 'context_job': return 'Wait for, inspect, cancel or dispose a Context Builder job. op=wait with durationMs returns when the job settles, asks a question or the time ends; repeat while state is not ready, blocked, failed or cancelled. A pending question arrives as a form, and only wait delivers and answers it. op=status returns the snapshot without waiting. op=cancel stops the job; a job already publishing finishes and returns {kind:publicationInProgress}. Ending a wait does not cancel the job. op=dispose cancels or joins the job and deletes its Git snapshots; its receipt and saved packet remain, and status still reports the same snapshot. A ready snapshot gives the bundle directory, context.md path, accounting, delivered materials, omissions and the resulting prompt; blocked snapshots report diagnostics, and failed or cancelled ones a code. Jobs end with the connection; saved packets remain.';
    case 'draft_finalize': return 'Publish an owned manual draft as a bundle beneath the workspace output root. Returns the bundle receipt (directory, context.md path and identity, accounting, materials and omissions) or the blocked validation with diagnostics, measurement and costs.';
    case 'context_prepare': return 'Publish a new bundle from a saved bundle with a replacement prompt, without a model call. workspace names the roots and output folder that built the bundle; bundle is its directory in that folder; prompt is the complete final task, delivered verbatim as user_instructions; outputName names the new bundle and fails with alreadyExists when the output folder already has an entry by that name. By default the saved evidence, constraints and formatting are reused after a check against current files; a change fails with sourceChanged or materialChanged and publishes nothing. Without budgetUnits, a prompt-only change raises the allowance to fit and a rebuild keeps the saved budget. These edits rebuild from current files: refresh: true, with the same selection, required inputs and preset; required, documents and patches, which add required inputs; and remove and demote, which take optional material paths as receipts list them (root/path, or a Git artifact alias) and otherwise fail with invalidSelection. remove drops files and Git artifacts; demote turns full files and slices into codemaps and drops the automatic codemaps that only they referenced. Selected Git artifacts stay unless removed; while any remain, edits need the saved evidence to match current files, and refresh fails with refreshRequiresDiscovery. Returns the bundle receipt with the materials added and removed, or blocked diagnostics such as overBudget.';
    case 'get_file_tree': return 'Render the workspace file tree. type=roots lists physical roots; type=files uses mode=auto, full, folders or selected. Defaults: files, auto mode, whole workspace, unlimited requested depth, first page. scope identifies a root and a root/descendant directory. maxDepth uses folder depth starting at zero and retains selected descendants. Selected mode requires an owned draft. Output pages preserve complete rendered lines; follow continuation for the remaining tree.';
    case 'git': return 'Inspect Git with op=status, log, show, blame or diff. Status/log/show/blame accept an ordered repositories:[{root,path?,worktree?}] list. Each root names a declared root; optional root-relative path identifies a nested repository. Optional absolute worktree selects a freshly verified advertised checkout of that repository. Status returns ordered repos for multiple distinct checkouts, including per-repository failures. Log/show/blame use the first repository and report a warning for multiple targets. Linked checkouts include worktree metadata and a warning. Omit repositories to use the owned draft’s frozen selected checkouts, or the first Git root without a draft. Implicit multi-repository log/show/blame require an explicit target; an unelected draft requires explicit read targets. Log defaults to ten commits. Log/blame paths are declared-root-relative for explicit roots, checkout-relative for repository path, worktree or implicit targets. Show accepts ref and summary/files/full detail. Diff uses root and optional worktree directly and defaults to uncommitted/summary, three context lines and detectRenames=false; compare also accepts staged, unstaged, base/merge-base forms, back:N, revision ranges and main/trunk. Diff path and paths are checkout-relative Git pathspecs; absolute paths are literal. One path upgrades summary to patches. Patches use a 300-line allowance; full retains complete hunks. Diff includes applicable untracked files and reports protected endpoints in exclusions. With an owned draft, artifacts=true publishes snapshots and adds mutable MAP/whole-patch selection. Options: mode=quick/standard/deep, scope=all/selected, snapshot_id and inline={map,mode,max_lines}. Per-file aliases are advertised for manage_selection. Publication and selection effects remain after failed reply admission; use manage_selection get to recover state. Ordinary file tools remain declared-root scoped. Git configuration must be trusted because clean/process filters may execute programs. The complete reply must fit maxOutputBytes.';
    case 'read_file': return 'Read a root-qualified source file, or omit root to read an exact selected _git_data/... artifact alias from the owning draft. MCP artifact reads require draftId. Advertised per-file patches must be selected before reading; selected historical artifacts remain readable after publication grants change. Defaults to the whole file, first page. start_line is one-based; a negative start reads the last N lines and cannot be combined with limit. limit=0 returns no lines; a negative limit reads the remainder. Starts beyond EOF return empty content with a message. offset is the current start_line alias. Numeric strings are accepted; an integer offset takes priority over a string start_line. Complete line records retain CRLF, CR and LF; continuations never split a line.';
    case 'get_code_structure': return 'Inspect source-backed graph evidence and signatures. Omit seeds to inspect current selected full/sliced sources; MCP callers supply an owned draftId for that selection. Explicit seeds accept up to 256 file or directory selectors. Directory selectors use directory={kind:root} or {kind:descendant,path}. Defaults: no expansion, depth 1, signatures=true, size=medium. expand=uses, used_by or both traverses root-local relationships at depths 1-4. size=small, medium or large controls graph and signature limits; signatures=false returns graph evidence alone. Results include seed/index states, canonical edges, unresolved names and partial-output diagnostics. maxOutputBytes admits the complete reply; use a narrower query or larger cap when it cannot fit.';
    case 'file_search': return 'Search paths/content with mode=auto (default), path, content or both. Example: {"query":{"text":"greet"}}. Auto mode chooses from the text: regex syntax, newlines or sentence-like text search content; wildcards, a leading * or . and slashes search paths; short or identifier-like text searches both. Omitted query.kind infers regex syntax. Explicit literal/regex kinds select interpretation; glob selects path mode. Matching is case-insensitive by default, including globs. Text patterns are trimmed. Literal content spaces match flexible whitespace and bypass wholeWord. Path candidates include relative and root-alias paths. maxResults defaults to 50 per stage; nonpositive values collect no results. Count-only scans all content matches and retains the path limit. Replies share a 48,000-character display allowance across content then path matches. sizeLimitHit and omitted counters identify excluded results. maxOutputBytes pages only the retained result set. filters.paths accepts raw file/folder paths, root aliases, absolute paths and wildcards as an OR scope. A path that does not exist is used as a path prefix instead; ambiguous scopes return a diagnostic. New searches reconcile the catalog; continuations stay generation-bound. Replies report scopedFileCount, enumeration coverage, unavailableRoots and per-file limitations. filters.extensions uses exact dotted names such as .swift; exclusions use case-insensitive substring or native wildcard matching. Filters apply before result limits. Context is optional.';
    case 'prompt': return 'List the configured raw copy presets with op=list_presets, including Manual and custom presets; no draft is required. Export the assembled context with op=export and path under the declared writable output root; optional copy_preset selects by UUID, kind or name for that export only. Export never overwrites a file and leaves the draft editable. Get the literal prompt, replace with op=set and text, append exact text with op=append, or clear with op=clear. Mutations require expectedRevision. Augment retains the original prefix; Preserve retains the original text. The resulting prompt is delivered verbatim in user_instructions.';
    case 'manage_selection': return 'Inspect or change selection using op=get, set, add, remove, preview, promote, demote or clear. Defaults: get, mode=full, strict=false, view=summary and relative path display. Views: summary, files, content, codemaps. paths accepts file/directory names, root aliases and absolute paths within declared roots; slices accepts described ranges or terminal #L ranges. Full add preserves existing slices; promote expands a file to full content. Codemap-only add, demote and promote keep the codemap mode, so automatic codemaps remain for the files the other selected files reference; clear with mode=codemap_only removes codemaps and enters manual mode. Full removal retains manual codemaps. Set rejects invalid inputs; preview does not commit selection. Explicit file registration remains workspace-owned and can survive a rejected selection. Mutations check the owning revision before selection commits. Selection commits before reply rendering and maxOutputBytes admission; later cancellation or reply failure retains the committed state. Use get or draft_inspect to recover current state after a missing or failed reply.';
    case 'draft_update': return 'Mutate at expectedRevision: upsert/remove source, clearCodemaps, clearSources or addDocument. Failed preparation or receipt admission commits nothing. Upserts keep the codemap mode. Removing explicit source may leave an inferred codemap; inferred-only removal is a no-op. clearCodemaps enters manual mode and removes optional codemaps; clearSources restores required sources and automatic mode. Both retain documents, patches and prompt. For unavailable inferred targets or inferred comparison mismatches, use clearCodemaps and add admissible codemaps with target evidence. Added documents are complete immutable suppliedDocument text with unique id, role and origin. Use prompt for literal prompt editing and manage_selection for path/slice operations and non-mutating preview.';
    default: return `mipmux ${name}`;
  }
}
