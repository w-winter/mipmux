import { ClipboardPreset, StoredPrompt, CapturedClipboardPreset, PromptSection as promptSection } from './presentation.js';
import { DecoderPolicy, IgnoreAuthority, IgnoreControl, IgnoreSettings } from './inventory.js';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { DirectoryRef, RelativePath, RootIdentity, RootName, SafeCount, SHA256, SourceIdentity } from './workspace.js';
import { ArtifactKey, Projection, Base64, SyntaxOutcome } from './artifact.js';
import { GitDiff, NativeGitReadQuery, NativeGitReadResult, NativeGitShowResult, NativeGitChangedFile } from './git.js';
import { NativeGitSnapshotInput, GitSnapshotPublicationOptions } from './git-snapshot.js';
import { NativeGitArtifactInput, NativeGitArtifactResult } from './git-artifact.js';
import { NativeGitWorktreeInput, NativeGitWorktreeResult } from './git-worktree.js';
import { NativeWireFailureCode } from './errors.js';
import { NativeAskUserInput, NativeAskUserResult } from './interaction.js';
import { NativeTokenStatsInput, NativeTokenStatsResult } from './token-accounting.js';
import { NativeSearchPatternInput, NativeSearchPatternResult, NativeSearchPathsInput, NativeSearchPathsResult,
  NativeLiteralSearchInput, NativeLiteralSearchResult, NativeRegexSearchInput, NativeRegexSearchResult,
  NativeRegexCompilationInput, NativeRegexCompilationResult, NativeSearchRecoveryInput, NativeSearchRecoveryResult,
  NativeSearchScopeInput, NativeSearchScopeResult, NativeSearchScopeRoot } from './search-pattern.js';

import { NativeStructureInput, NativeStructureResult } from './structure.js';
export { NativeStructureInput, NativeStructureResult } from './structure.js';

const handle = Type.Object({ generation: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export type NativeHandle = Static<typeof handle>;
const base64 = Base64;
const access = Type.Union([Type.Literal('source'), Type.Literal('output')]);
const filename = Type.Union([Type.Literal('context.md'), Type.Literal('handoff.md')]);
const declaration = Type.Object({
  name: RootName, absolutePath: Type.String({ pattern: '^/[^\\u0000]*$' }), access,
  expected: Type.Union([RootIdentity, Type.Null()]),
}, { additionalProperties: false });
export const NativeFileTreeInput = Type.Object({ kind: Type.Literal('renderFileTree'),
  roots: Type.Array(Type.Object({ name: RootName, path: Type.String() }, { additionalProperties: false })),
  entries: Type.Array(Type.Union([
    Type.Object({ kind: Type.Literal('directory'), root: RootName, path: RelativePath }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('file'), root: RootName, path: RelativePath, selected: Type.Boolean(), hasCodeMap: Type.Boolean() }, { additionalProperties: false }),
  ])),
  scope: Type.Union([Type.Object({ root: RootName, path: Type.String() }, { additionalProperties: false }), Type.Null()]),
  mode: Type.Enum(['auto', 'full', 'folders', 'selected']),
  maxDepth: Type.Union([Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
  includeLegend: Type.Boolean(), showFullPaths: Type.Boolean(),
  onlyIncludeRootsWithSelectedFiles: Type.Boolean(), showCodeMapMarkers: Type.Boolean(),
}, { additionalProperties: false });
export const NativeFileTreeResult = Type.Object({ kind: Type.Literal('fileTree'), tree: Type.String(), rootsCount: SafeCount,
  note: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false });
export type NativeFileTreeResult = Static<typeof NativeFileTreeResult>;
const snippetText = Type.Union([Type.String(), Type.Null()]);
const clipboardLine = Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const clipboardRange = Type.Object({ start: clipboardLine, end: clipboardLine, description: snippetText }, { additionalProperties: false });
export const NativeClipboardInput = Type.Object({ kind: Type.Literal('renderClipboard'), input: Type.Object({
  metaInstructions: Type.Array(Type.Object({ title: Type.String(), content: Type.String() }, { additionalProperties: false })),
  userInstructions: Type.String(), files: Type.Array(Type.Object({
    file: Type.Object({ id: Type.String(), rootID: Type.String(), name: Type.String(), relativePath: Type.String(),
      fullPath: Type.String() }, { additionalProperties: false }),
    role: Type.Enum(['ordinary', 'authorizedGitDiffArtifact']), isCodemap: Type.Boolean(), loadedContent: snippetText,
    lineRanges: Type.Union([Type.Array(clipboardRange), Type.Null()]), rootFolderPath: snippetText,
  }, { additionalProperties: false })), fileTreeContent: snippetText, gitDiff: snippetText,
  includeSavedPrompts: Type.Boolean(), includeFiles: Type.Boolean(), includeUserPrompt: Type.Boolean(),
  includeDatetimeInUserInstructions: Type.Boolean(),
  filePathDisplay: Type.Enum(['full', 'relative']),
  codemapPresentation: Type.Object({ renderedEntriesByFileID: Type.Record(Type.String(),
    Type.Object({ text: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }),
  promptSectionsOrder: Type.Array(promptSection), disabledPromptSections: Type.Array(promptSection),
  duplicateUserInstructionsAtTop: Type.Boolean(), tabTitle: snippetText,
}, { additionalProperties: false }) }, { additionalProperties: false });
export const NativePreparedClipboardInput = Type.Object({ kind: Type.Literal('renderPreparedClipboard'), input: Type.Object({
  duplicateUserInstructionsAtTop: Type.Boolean(),
  includeDatetimeInUserInstructions: Type.Boolean(),
  promptSectionsOrder: Type.Array(promptSection),
  copyPreset: ClipboardPreset, storedPrompts: Type.Array(StoredPrompt),
  codemapBlocks: Type.Array(Type.String()), contentBlocks: Type.Array(Type.String()), fileTreeContent: Type.String(),
  selectedGitDiffs: Type.Array(Type.Object({ id: Type.String(), text: Type.String() }, { additionalProperties: false })),
  gitDiff: snippetText, automaticGitDiff: snippetText, userInstructions: Type.String(),
  metaInstructions: Type.Array(Type.Object({ title: Type.String(), content: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false }) }, { additionalProperties: false });
export const NativePromptAssemblyInput = Type.Object({ kind: Type.Literal('renderPromptAssembly'),
  order: Type.Array(promptSection), disabled: Type.Array(promptSection), duplicateUserInstructionsAtTop: Type.Boolean(),
  snippets: Type.Object({ fileMap: snippetText, fileContents: snippetText, gitDiff: snippetText,
    metaPrompts: snippetText, userInstructions: snippetText }, { additionalProperties: false }),
}, { additionalProperties: false });
export const NativeDiscoveryMessageInput = Type.Object({ kind: Type.Literal('renderDiscoveryMessage'), tokenBudget: SafeCount,
  fileTree: Type.String(), currentPrompt: Type.String(), discoveryInstructions: Type.String(),
  contextBuilderPrompts: Type.Array(Type.Object({ title: Type.String(), content: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });
export const NativeSliceRange = Type.Object({ start: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  end: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), description: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false });
const canonicalSelectionPath = Type.String({ pattern: '^/[^\\u0000]*$' });
export const NativeSelectionState = Type.Object({ selectedPaths: Type.Array(canonicalSelectionPath),
  manualCodemapPaths: Type.Array(canonicalSelectionPath), slices: Type.Record(Type.String(), Type.Array(NativeSliceRange)),
  codemapAutoEnabled: Type.Boolean() }, { additionalProperties: false });
export const NativeSelectionTransitionInput = Type.Object({ kind: Type.Literal('transitionSelection'), selection: NativeSelectionState,
  mutation: Type.Union([
    Type.Object({ kind: Type.Literal('fullFiles'), op: Type.Enum(['add', 'remove']), paths: Type.Array(canonicalSelectionPath) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('representation'), target: Type.Enum(['full', 'codemapOnly', 'unselected']),
      paths: Type.Array(canonicalSelectionPath) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('gitPublication'), contextSelection: NativeSelectionState }, { additionalProperties: false }),
  ]) }, { additionalProperties: false });
export const NativeSliceRangesInput = Type.Object({ kind: Type.Literal('calculateSliceRanges'),
  op: Type.Enum(['normalize', 'coalesce', 'subtract']), base: Type.Array(NativeSliceRange), ranges: Type.Array(NativeSliceRange),
}, { additionalProperties: false });
export const NativePathMatchInput = Type.Object({ kind: Type.Literal('matchSelectionPath'), query: Type.String(),
  roots: Type.Array(Type.Object({ name: Type.String(), path: Type.String(), files: Type.Array(RelativePath),
    directories: Type.Array(RelativePath) }, { additionalProperties: false })) }, { additionalProperties: false });
const NativeSelectionCatalogMember = Type.Object({ path: RelativePath, discoverable: Type.Boolean() }, { additionalProperties: false });
export const NativeSelectionCandidatesInput = Type.Object({ kind: Type.Literal('resolveSelectionCandidates'),
  paths: Type.Array(Type.String()), rawPaths: Type.Array(Type.String()), expandFolders: Type.Boolean(),
  allowEmptyFolderExpansion: Type.Boolean(), mode: Type.Enum(['full', 'codemapOnly']),
  roots: Type.Array(Type.Object({ id: Type.String({ format: 'uuid' }), name: Type.String(), path: Type.String({ pattern: '^/[^\\u0000]*$' }),
    files: Type.Array(NativeSelectionCatalogMember), directories: Type.Array(NativeSelectionCatalogMember) }, { additionalProperties: false })),
  materialization: Type.Array(Type.Object({ path: Type.String(), outcome: Type.Enum(['noCandidate', 'ambiguous', 'blocked', 'unavailable', 'failed']) }, { additionalProperties: false })),
}, { additionalProperties: false });
export const NativeSelectionCandidatesResult = Type.Object({ kind: Type.Literal('selectionCandidates'),
  candidates: Type.Array(Type.Object({ rootId: Type.String({ format: 'uuid' }), path: RelativePath }, { additionalProperties: false })),
  resolvedMap: Type.Record(Type.String(), Type.String()), invalidPaths: Type.Array(Type.String()), codemapUnavailable: Type.Array(Type.String()),
}, { additionalProperties: false });
const parsedSearchScope = Type.Object({
  spec: Type.Object({ caseInsensitive: Type.Boolean(), clauses: NativeSearchScopeInput.properties.clauses }, { additionalProperties: false }),
  issues: Type.Array(Type.String()),
  freshnessRootRefs: Type.Array(NativeSearchScopeRoot),
  exactClauses: Type.Array(Type.Object({ clauseIndex: SafeCount, rootID: Type.String({ format: 'uuid' }), relativePath: Type.String(),
    missingClauses: NativeSearchScopeInput.properties.clauses }, { additionalProperties: false })),
}, { additionalProperties: false });
/** Parses or refreshes scope metadata from captured catalogs; the caller establishes filesystem freshness. */
export const NativeSearchScopeResolutionInput = Type.Union([
  Type.Object({ kind: Type.Literal('parseSearchScope'), roots: NativeSelectionCandidatesInput.properties.roots,
    paths: Type.Array(Type.String()), caseInsensitive: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('refreshSearchScope'), roots: NativeSelectionCandidatesInput.properties.roots,
    scope: parsedSearchScope }, { additionalProperties: false }),
]);
export const NativeSearchScopeParsingResult = Type.Object({ kind: Type.Literal('searchScopeParsed'), scope: parsedSearchScope }, { additionalProperties: false });
export const NativeSelectionPathMutationInput = Type.Object({ kind: Type.Literal('mutateSelectionPaths'),
  selection: NativeSelectionState,
  catalog: Type.Object({ roots: NativeSelectionCandidatesInput.properties.roots,
    materialization: NativeSelectionCandidatesInput.properties.materialization }, { additionalProperties: false }),
  mutation: Type.Union([
    Type.Object({ op: Type.Enum(['add', 'remove']), mode: Type.Enum(['full', 'codemap_only']),
      paths: Type.Array(Type.String()), rawPaths: Type.Array(Type.String()) }, { additionalProperties: false }),
    Type.Object({ op: Type.Enum(['promote', 'demote']), paths: Type.Array(Type.String()),
      rawPaths: Type.Array(Type.String()) }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false });
const selectionPathResult = { kind: Type.Literal('selectionPathMutation'), selection: NativeSelectionState,
  invalidPaths: Type.Array(Type.String()), mutated: Type.Boolean() };
const selectionPathResolved = Type.Record(Type.String(), Type.String());
export const NativeSelectionPathMutationResult = Type.Union([
  Type.Object({ ...selectionPathResult, op: Type.Literal('add'), resolvedMap: selectionPathResolved,
    codemapUnavailable: Type.Array(Type.String()) }, { additionalProperties: false }),
  Type.Object({ ...selectionPathResult, op: Type.Literal('remove'), resolvedMap: selectionPathResolved }, { additionalProperties: false }),
  Type.Object({ ...selectionPathResult, op: Type.Literal('promote'), validCandidateCount: SafeCount }, { additionalProperties: false }),
  Type.Object({ ...selectionPathResult, op: Type.Literal('demote'), validCandidateCount: SafeCount,
    codemapUnavailable: Type.Array(Type.String()) }, { additionalProperties: false }),
]);
const NativeSelectionSliceInput = Type.Object({ path: Type.String(), ranges: Type.Array(NativeSliceRange) }, { additionalProperties: false });
export const NativeSelectionPreparationInput = Type.Object({ kind: Type.Literal('prepareSelection'), selection: NativeSelectionState,
  catalog: NativeSelectionPathMutationInput.properties.catalog,
  mutation: Type.Union([
    Type.Object({ kind: Type.Literal('set'), mode: Type.Enum(['full', 'slices', 'codemap_only']), paths: Type.Array(Type.String()),
      slices: Type.Array(NativeSelectionSliceInput), sliceErrors: Type.Array(Type.String()), hasFullFileArtifactInputs: Type.Boolean() }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('slices'), op: Type.Enum(['add', 'remove', 'set', 'setPaths']),
      entries: Type.Array(NativeSelectionSliceInput) }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false });
export const NativeSelectionPreparationResult = Type.Union([
  Type.Object({ kind: Type.Literal('selectionBuilt'), selection: NativeSelectionState,
    invalidPaths: Type.Array(Type.String()), codemapUnavailable: Type.Array(Type.String()) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('selectionSlicesChanged'), selection: NativeSelectionState,
    invalidPaths: Type.Array(Type.String()), resolvedMap: selectionPathResolved, mutated: Type.Boolean() }, { additionalProperties: false }),
]);
export const NativeSelectionInputParsingRequest = Type.Object({ kind: Type.Literal('parseSelectionInputs'),
  paths: Type.Array(Type.String()), slices: Type.Unknown() }, { additionalProperties: false });
export const NativeSelectionInputParsingResult = Type.Object({ kind: Type.Literal('selectionInputs'), paths: Type.Array(Type.String()),
  slices: Type.Array(NativeSelectionSliceInput), sliceErrors: Type.Array(Type.String()), hadExplicitSliceSpec: Type.Boolean() }, { additionalProperties: false });
const SelectionPathBindingsInput = Type.Object({ kind: Type.Literal('selectionPathBindings'),
  paths: Type.Array(Type.String()) }, { additionalProperties: false });
const SelectionPathBindingsResult = Type.Object({ kind: Type.Literal('selectionPathBindings'),
  paths: Type.Array(Type.String()) }, { additionalProperties: false });
const SelectionHintInput = Type.Object({ kind: Type.Literal('selectionHint'),
  roots: Type.Array(Type.Object({ name: Type.String(), path: Type.String({ pattern: '^/[^\\u0000]*$' }) }, { additionalProperties: false }), { minItems: 1 }),
  paths: Type.Array(Type.String()), operation: Type.String() }, { additionalProperties: false });
const SelectionHintResult = Type.Object({ kind: Type.Literal('selectionHint'), message: Type.String() }, { additionalProperties: false });
const selectionReplyFields = { path: Type.String(), rootPath: Type.String(), pathWithinRoot: Type.String(), tokens: SafeCount };
export const NativeSelectionReplyInput = Type.Object({ kind: Type.Literal('renderSelectionReply'), entries: Type.Array(Type.Union([
  Type.Object({ ...selectionReplyFields, kind: Type.Literal('full') }, { additionalProperties: false }),
  Type.Object({ ...selectionReplyFields, kind: Type.Literal('slice'), ranges: Type.Array(NativeSliceRange, { minItems: 1 }) }, { additionalProperties: false }),
  Type.Object({ ...selectionReplyFields, kind: Type.Literal('codemap'), origin: Type.Enum(['auto', 'manual']) }, { additionalProperties: false }),
])), status: Type.Enum(['ok', 'preview']), codemapAutoEnabled: Type.Boolean(), invalidPaths: Type.Array(Type.String()),
  unmappedPaths: Type.Array(Type.String()), pendingPaths: Type.Array(Type.String()), blocks: Type.Union([Type.Array(Type.String()), Type.Null()]),
  view: Type.Enum(['summary', 'files', 'content', 'codemaps']) }, { additionalProperties: false });
const selectionRangeDTO = Type.Object({ start_line: SafeCount, end_line: SafeCount, description: Type.Optional(Type.String()) }, { additionalProperties: false });
const selectionFileDTO = Type.Object({ path: Type.String(), tokens: SafeCount, render_mode: Type.Enum(['full', 'slice', 'codemap']),
  ranges: Type.Optional(Type.Array(selectionRangeDTO)), is_auto: Type.Boolean(), codemap_origin: Type.Optional(Type.Enum(['auto', 'manual', 'selected_mode'])),
  root_path: Type.String(), path_within_root: Type.String() }, { additionalProperties: false });
export const NativeSelectionReplyResult = Type.Object({ kind: Type.Literal('selectionReply'), reply: Type.Object({
  files: Type.Array(selectionFileDTO), total_tokens: SafeCount, status: Type.Enum(['ok', 'preview']),
  invalid_paths: Type.Optional(Type.Array(Type.String())), blocks: Type.Optional(Type.Array(Type.String())),
  code_structure: Type.Optional(Type.Object({ file_count: SafeCount, content: Type.String(),
    unmapped_paths: Type.Optional(Type.Array(Type.String())), pending_paths: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false })),
  file_slices: Type.Optional(Type.Array(Type.Object({ path: Type.String(), ranges: Type.Array(selectionRangeDTO),
    root_path: Type.String(), path_within_root: Type.String() }, { additionalProperties: false }))),
  codemap_auto_enabled: Type.Boolean(), code_map_usage: Type.Literal('auto'),
  summary: Type.Object({ full_count: SafeCount, slice_count: SafeCount, codemap_count: SafeCount,
    full_tokens: SafeCount, slice_tokens: SafeCount, codemap_tokens: SafeCount }, { additionalProperties: false }),
}, { additionalProperties: false }) }, { additionalProperties: false });
export const NativeReadArgument = Type.Union([Type.Integer(), Type.String(), Type.Null()]);
export const NativeReadTextInput = Type.Object({ kind: Type.Literal('sliceReadText'), text: Type.String(),
  start_line: NativeReadArgument, offset: NativeReadArgument, limit: NativeReadArgument }, { additionalProperties: false });
export const NativeFileBlockInput = Type.Object({ kind: Type.Literal('renderFileBlock'),
  selectedPath: Type.String(), fileName: Type.String(), content: Type.String(),
  ranges: Type.Union([Type.Array(NativeSliceRange), Type.Null()]),
}, { additionalProperties: false });
export const NativeFileBlockResult = Type.Object({ kind: Type.Literal('fileBlock'), text: Type.String(),
  bodySpans: Type.Array(Type.Object({ offset: SafeCount, length: SafeCount }, { additionalProperties: false })),
  segments: Type.Array(Type.Object({ ...NativeSliceRange.properties, text: Type.String() }, { additionalProperties: false })),
  combinedText: Type.String(), totalLines: SafeCount, detectedLineEnding: Type.String(), isFullFile: Type.Boolean(),
}, { additionalProperties: false });
export const NativeReadTextResult = Type.Union([
  Type.Object({ kind: Type.Literal('readTextSlice'), content: Type.String(), totalLines: SafeCount,
    firstLine: Type.Integer({ minimum: 0 }), lastLine: SafeCount, returnedLineCount: SafeCount, message: Type.Union([Type.String(), Type.Null()]),
    lines: Type.Array(Type.Object({ number: SafeCount, offset: SafeCount, length: SafeCount, text: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('readTextRangeError'), code: Type.Enum(['limitWithNegativeStart', 'zeroStart']), message: Type.String() }, { additionalProperties: false }),
]);
const IgnorePolicy = Type.Union([
  Type.Object({ kind: Type.Literal('git'), prefix: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('nonGit') }, { additionalProperties: false }),
]);
const IgnoreControlText = Type.Union([Type.String(), Type.Null()]);
const IgnoreQueryInput = Type.Object({ kind: Type.Literal('queryIgnoreRules'), policy: IgnorePolicy,
  controls: Type.Object({ gitignore: IgnoreControlText, global: Type.String(), repoIgnore: IgnoreControlText,
    cursorignore: IgnoreControlText, respectRepoIgnore: Type.Boolean(), respectCursorignore: Type.Boolean() }, { additionalProperties: false }),
  layers: Type.Array(Type.Object({ content: Type.String(), directory: Type.String(), authority: Type.Enum(['mandatoryGit', 'secondary']) }, { additionalProperties: false })),
  queries: Type.Array(Type.Object({ path: Type.String(), isDirectory: Type.Boolean() }, { additionalProperties: false })) }, { additionalProperties: false });
const IgnoreQueryResult = Type.Object({ kind: Type.Literal('ignoreRules'), hasNegative: Type.Boolean(),
  paths: Type.Array(Type.Object({ path: Type.String(), isDirectory: Type.Boolean(), ignored: Type.Boolean(),
    match: Type.Enum(['ignore', 'allow', 'none']), requiresTraversal: Type.Boolean() }, { additionalProperties: false })),
  traversal: Type.Object({ exactPrefixCount: SafeCount, patternHintCount: SafeCount, broadPatternHintCount: SafeCount,
    basenameOnlyNegationCount: SafeCount }, { additionalProperties: false }) }, { additionalProperties: false });
const NativeGitCommitInfo = Type.Object({ id: Type.String(), shortID: Type.String(), author: Type.String(),
  dateISO: Type.String(), message: Type.String() }, { additionalProperties: false });
const NativeGitComparison = Type.Union([
  Type.Object({ kind: Type.Literal('uncommitted'), base: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('uncommittedMergeBase'), base: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('staged'), base: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('stagedMergeBase'), base: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('unstaged') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('revspec'), spec: Type.String() }, { additionalProperties: false }),
]);
const NativeGitPatchInput = Type.Object({ kind: Type.Literal('parseGitPatch'), text: Type.String() }, { additionalProperties: false });
const NativeGitPatchResult = Type.Object({ kind: Type.Literal('gitPatch'),
  files: Type.Array(Type.Object({ path: Type.String(), patch: Type.String(), insertions: Type.Integer(), deletions: Type.Integer(),
    hunks: Type.Array(Type.Object({ header: Type.String(), oldStart: Type.Integer(), oldLines: Type.Integer(),
      newStart: Type.Integer(), newLines: Type.Integer(), content: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false })),
  changedLinesTsv: Type.String() }, { additionalProperties: false });
export const NativeIgnoreInputs = Type.Object({
  kind: Type.Literal('ignoreInputs'), authority: IgnoreAuthority, settings: IgnoreSettings, controls: Type.Array(IgnoreControl),
}, { additionalProperties: false });
const IgnoreCapture = Type.Object({ kind: Type.Literal('captureIgnoreInputs'), root: handle, directory: DirectoryRef,
  settings: Type.Union([IgnoreSettings, Type.Null()]), deniedAbsolutePaths: Type.Array(canonicalSelectionPath),
}, { additionalProperties: false });
const IgnoreHierarchy = Type.Object({ kind: Type.Literal('queryIgnoreHierarchy'), capture: IgnoreCapture, rootInputs: NativeIgnoreInputs,
  directories: Type.Array(Type.Object({ path: RelativePath, controls: Type.Array(IgnoreControl) }, { additionalProperties: false })),
  queries: Type.Array(Type.Object({ path: Type.String(), isDirectory: Type.Boolean() }, { additionalProperties: false })),
}, { additionalProperties: false });

export const NativeGitCheckout = Type.Object({ root: Type.String(), checkoutRootPath: Type.String(), repoKey: Type.String(),
  repositoryID: Type.String(), worktreeID: Type.String(), kind: Type.Enum(['canonical', 'linkedWorktree']) }, { additionalProperties: false });
export type NativeGitCheckout = Static<typeof NativeGitCheckout>;
export const AutomaticReviewGitCheckout = Type.Object({ identity: NativeGitCheckout, displayLabel: Type.String(),
  selectedPaths: Type.Array(Type.String()) }, { additionalProperties: false });
export const AutomaticReviewGitPathIssue = Type.Union([
  Type.Object({ kind: Type.Enum(['unresolvedSelection', 'noRepository', 'invalidGitLayout']), displayPath: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('unsupportedBackend'), displayPath: Type.String(), backend: Type.Enum(['git', 'jujutsu']) }, { additionalProperties: false }),
]);
const reviewOutcome = { checkout: AutomaticReviewGitCheckout };
export const AutomaticReviewGitOutcome = Type.Union([
  Type.Object({ ...reviewOutcome, kind: Type.Literal('diff'), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ ...reviewOutcome, kind: Type.Enum(['noChanges', 'baseResolutionFailed', 'commandFailed']) }, { additionalProperties: false }),
]);
const automaticReviewGitInput = Type.Union([
  Type.Object({ kind: Type.Literal('resolveAutomaticReviewGit'),
    roots: Type.Array(Type.Object({ name: Type.String(), path: Type.String() }, { additionalProperties: false })),
    paths: Type.Array(Type.String()), base: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('renderAutomaticReviewGit'), outcomes: Type.Array(AutomaticReviewGitOutcome),
    pathIssues: Type.Array(AutomaticReviewGitPathIssue) }, { additionalProperties: false }),
]);
export const AutomaticReviewGitCompleteness = Type.Enum(['complete', 'partial', 'failed']);
export const NativeOperation = Type.Union([
  NativeSearchPatternInput,
  NativeSearchPathsInput,
  NativeLiteralSearchInput,
  NativeRegexSearchInput,
  NativeRegexCompilationInput,
  NativeSearchRecoveryInput,
  NativeSearchScopeInput,
  ...NativeSearchScopeResolutionInput.anyOf,
  NativeTokenStatsInput,
  ...automaticReviewGitInput.anyOf,
  ...NativeGitWorktreeInput.anyOf,
  ...NativeGitArtifactInput.anyOf,
  Type.Object({ kind: Type.Literal('authorizeGitArtifact'), manifest: base64, snapshotDir: Type.String(),
    path: RelativePath, ownerID: Type.String(), checkout: NativeGitCheckout }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('fingerprintGitDiff'), root: handle, compare: Type.String(), headSHA: Type.String(),
    baseRefSHA: Type.String(), status: base64 }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('beginGitSnapshot'), root: handle, repoKey: Type.String(), snapshotID: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('resolveGitSnapshotID'), root: handle, repoKey: Type.String(), snapshotID: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('prepareGitPublicationMetadata'), repoRoot: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('normalizeGitPublicationOptions'), mode: Type.String(), scope: Type.String(),
    snapshotID: Type.Union([Type.String(), Type.Null()]), inlineMap: Type.Boolean(), inlineMode: Type.String(),
    inlineMaxLines: Type.Integer() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('planGitPublication'), repositories: Type.Array(Type.String()), paths: Type.Array(Type.String()),
    pathspecs: Type.Array(Type.String()), scope: NativeGitSnapshotInput.properties.scope }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('readGitSnapshotCurrent'), root: handle, repoKey: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('listGitSnapshots'), root: handle }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('maintainGitSnapshots'), root: handle, action: Type.Union([
    Type.Object({ kind: Type.Literal('opened') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('published'), repoKey: Type.String(), snapshotID: Type.String(), generatedAt: Type.String() }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('closed'), tabIDs: Type.Array(Type.String()) }, { additionalProperties: false }),
  ]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('resolveGitSnapshotComparison'), output: handle, repository: handle, compare: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('writeGitSnapshotCurrent'), run: handle }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('finishGitSnapshot'), run: handle }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('readGitSnapshotFile'), root: handle, repoKey: Type.String(), snapshotID: Type.String(), path: RelativePath }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('writeGitSnapshotFile'), run: handle, path: RelativePath, bytes: base64 }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('serializeGitSnapshot'), input: NativeGitSnapshotInput }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('revalidateGitTargets'), checkouts: Type.Array(NativeGitCheckout) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('electGitTarget'), roots: Type.Array(Type.Object({ name: Type.String(), path: Type.String() }, { additionalProperties: false })),
    paths: Type.Array(Type.String()) }, { additionalProperties: false }),
  NativeFileBlockInput,
  IgnoreCapture, IgnoreHierarchy,
  IgnoreQueryInput,
  NativeGitPatchInput,
  Type.Object({ kind: Type.Literal('parseGitComparison'), raw: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('normalizeGitDiffPaths'), paths: Type.Array(Type.String()), repoRootPath: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('normalizeGitSelectedPaths'), paths: Type.Array(Type.String()), repoRootPath: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('prepareGitDiff'), compare: Type.Union([Type.String(), NativeGitComparison]), paths: Type.Array(Type.String()), repoRootPath: Type.String(),
    contextLines: Type.Integer(), detectRenames: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('parseGitDiffStats'), numstat: base64, nameStatus: base64,
    untracked: Type.Array(Type.Object({ path: Type.String(), bytes: Type.Union([base64, Type.Null()]) }, { additionalProperties: false })) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('normalizeGitUntrackedPatch'), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('projectGitDiff'), compare: Type.String(), detail: Type.String(), pathspecCount: SafeCount,
    isMultiRepo: Type.Boolean(), changedFiles: Type.Array(NativeGitChangedFile),
    perFilePatches: Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('prepareGitShow'), ref: Type.String(), detail: Type.String(), contextLines: Type.Integer(),
    detectRenames: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('parseGitShowMetadata'), bytes: base64 }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('projectGitShow'), detail: Type.String(), metadata: NativeGitCommitInfo, numstat: base64, nameStatus: base64,
    patch: Type.Union([base64, Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('prepareGitRead'), query: NativeGitReadQuery }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('projectGitRead'), query: NativeGitReadQuery, bytes: base64 }, { additionalProperties: false }),
  NativeReadTextInput,
  ...NativeAskUserInput.anyOf,
  NativeSelectionInputParsingRequest,
  SelectionPathBindingsInput,
  SelectionHintInput,
  NativeSelectionReplyInput,
  NativeSelectionPreparationInput,
  NativeSelectionPathMutationInput,
  NativeSelectionCandidatesInput,
  NativePathMatchInput,
  NativeSliceRangesInput,
  NativeSelectionTransitionInput,
  NativeDiscoveryMessageInput,
  Type.Object({ kind: Type.Literal('describe') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('openRoots'), roots: Type.Array(declaration, { minItems: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('listDirectory'), root: handle, directory: DirectoryRef }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('readSource'), root: handle, path: RelativePath, expected: Type.Union([SourceIdentity, Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('extract'), extension: Type.String(), bytes: base64, expected: SourceIdentity }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('beginExport'), root: handle, name: Type.String({ pattern: '^[^/\\u0000]+$' }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('writeExport'), run: handle, filename, bytes: base64 }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('readExport'), run: handle, filename }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('publishManifest'), run: handle, bytes: base64 }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('renderDiscoveryPrompt'), tokenBudget: SafeCount,
    runtime: Type.Enum(['codexExec', 'generic']), enhancementMode: Type.Enum(['fullRewrite', 'augment', 'preserve']),
    allowClarifyingQuestions: Type.Boolean(), responseType: Type.Union([Type.String(), Type.Null()]),
    instructions: Type.Union([Type.String(), Type.Null()]), questionTimeoutSeconds: SafeCount,
    restrictsReviewGitToExplicitReadOnly: Type.Boolean(), reviewRootNames: Type.Array(Type.String()),
  }, { additionalProperties: false }),
  NativeFileTreeInput,
  NativePromptAssemblyInput,
  NativeClipboardInput,
  NativePreparedClipboardInput,
  NativeStructureInput,
]);
export type NativeOperation = Static<typeof NativeOperation>;
export const NativeRequest = Type.Object({
  wireVersion: Type.Literal(1), requestId: Type.String({ minLength: 1 }),
  generation: Type.String({ minLength: 1 }), operation: NativeOperation,
}, { additionalProperties: false });
export type NativeRequest = Static<typeof NativeRequest>;

const decimal = Type.String({ pattern: '^-?[0-9]+$' });
export const DescriptorFingerprint = Type.Object({
  device: decimal, inode: decimal, size: SafeCount, mode: SafeCount,
  modifiedSeconds: decimal, modifiedNanoseconds: SafeCount,
  changedSeconds: decimal, changedNanoseconds: SafeCount,
}, { additionalProperties: false });
export type DescriptorFingerprint = Static<typeof DescriptorFingerprint>;

export const NativeResult = Type.Union([
  ...NativeSearchPatternResult.anyOf,
  ...NativeSearchPathsResult.anyOf,
  NativeLiteralSearchResult,
  ...NativeRegexSearchResult.anyOf,
  ...NativeRegexCompilationResult.anyOf,
  NativeSearchRecoveryResult,
  NativeSearchScopeResult,
  NativeSearchScopeParsingResult,
  NativeTokenStatsResult,
  ...NativeGitWorktreeResult.anyOf,
  Type.Object({ kind: Type.Literal('gitDiffFingerprint'), fingerprint: NativeGitSnapshotInput.properties.fingerprint }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitSnapshotOpened'), run: handle, relativePath: Type.String(), snapshotID: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitSnapshotID'), snapshotID: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitPublicationMetadata'), graphArguments: Type.Array(Type.String()),
    worktree: NativeGitSnapshotInput.properties.worktree }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitPublicationOptions'), options: GitSnapshotPublicationOptions }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitPublicationOptionsError'), message: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitPublicationPlan'), maxConcurrentRepositories: SafeCount,
    repositories: Type.Array(Type.Object({ path: Type.String(), name: Type.String(), selectedPaths: Type.Array(Type.String()),
      usesSelectedScope: Type.Boolean(), emptyReason: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false })) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitSnapshotCurrent'), snapshotID: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitSnapshots'), snapshots: Type.Array(Type.Object({ repoKey: Type.String(), snapshotID: Type.String(),
    generatedAt: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitSnapshotsMaintained'), outcome: Type.Union([
    Type.Object({}, { additionalProperties: false }),
    Type.Object({ expiredDeleted: SafeCount, excessDeleted: SafeCount }, { additionalProperties: false }),
    Type.Object({ deleted: SafeCount }, { additionalProperties: false }),
  ]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitSnapshotComparison'), comparison: NativeGitComparison, resolved: Type.String(),
    input: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitSnapshotComparisonError'), code: Type.Enum(['gitSnapshotUnavailable', 'gitSnapshotManifestUnavailable', 'gitSnapshotNotFound']),
    message: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitSnapshotCurrentWritten'), snapshotID: Type.String(), pointer: Type.Union([
    Type.Object({ kind: Type.Literal('symlink') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('file'), symlinkErrno: Type.Integer() }, { additionalProperties: false }),
  ]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitSnapshotRead'), bytes: base64, identity: SourceIdentity }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitSnapshotFileWritten'), identity: SourceIdentity }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitSnapshotBytes'), files: Type.Array(Type.Object({ path: Type.String(), bytes: base64 }, { additionalProperties: false })) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitSnapshotFinished') }, { additionalProperties: false }),
  ...NativeGitArtifactResult.anyOf,
  Type.Object({ kind: Type.Literal('gitArtifactAuthorization'), authorized: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitTargetValidation'), valid: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitTarget'), state: Type.Literal('deferred') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitTarget'), state: Type.Literal('unavailable'),
    reason: Type.Enum(['nonGitSelection', 'ambiguousOwnership', 'emptySelection']), count: SafeCount }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitTarget'), state: Type.Literal('available'), checkouts: Type.Array(NativeGitCheckout, { minItems: 1 }),
    primary: NativeGitCheckout }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('preparedClipboard'), text: Type.String(), preset: CapturedClipboardPreset,
    selectedGitDiffIds: Type.Array(Type.String()), needsAutomaticGit: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('automaticReviewGitPaths'), checkouts: Type.Array(AutomaticReviewGitCheckout),
    pathIssues: Type.Array(AutomaticReviewGitPathIssue), base: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('automaticReviewGit'), text: snippetText, completeness: AutomaticReviewGitCompleteness,
    outcomes: Type.Array(AutomaticReviewGitOutcome), bodySpans: Type.Array(Type.Object({ offset: SafeCount, length: SafeCount }, { additionalProperties: false })) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('clipboard'), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('promptAssembly'), text: Type.String() }, { additionalProperties: false }),
  NativeFileBlockResult,
  NativeIgnoreInputs,
  Type.Object({ kind: Type.Literal('ignoreHierarchy'), paths: Type.Array(Type.Union([
    Type.Object({ path: Type.String(), isDirectory: Type.Literal(false), ignored: Type.Boolean() }, { additionalProperties: false }),
    Type.Object({ path: Type.String(), isDirectory: Type.Literal(true), ignored: Type.Boolean(),
      requiresTraversal: Type.Boolean(), directoryIncluded: Type.Boolean() }, { additionalProperties: false }),
  ])), directories: IgnoreHierarchy.properties.directories }, { additionalProperties: false }),
  IgnoreQueryResult,
  NativeGitPatchResult,
  Type.Object({ kind: Type.Literal('gitComparison'), comparison: NativeGitComparison, rawKey: Type.String(), display: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitDiffPaths'), paths: Type.Array(Type.String()), pathspecs: Type.Array(Type.String()) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitDiff'), diff: GitDiff }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitDiffArguments'), comparison: NativeGitComparison, display: Type.String(), rawKey: Type.String(),
    paths: Type.Array(Type.String()), pathspecs: Type.Array(Type.String()), inputCount: SafeCount, hasRelativeInputs: Type.Boolean(),
    includeUntracked: Type.Boolean(), numstat: Type.Array(Type.String()), nameStatus: Type.Array(Type.String()),
    patch: Type.Array(Type.String()) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitDiffStats'), files: Type.Array(NativeGitChangedFile) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitUntrackedPatch'), text: Type.String() }, { additionalProperties: false }),
  ...NativeGitReadResult.anyOf,
  Type.Object({ kind: Type.Literal('gitShowArguments'), ref: Type.String(), metadata: Type.Array(Type.String()),
    numstat: Type.Array(Type.String()), nameStatus: Type.Array(Type.String()),
    patch: Type.Union([Type.Array(Type.String()), Type.Null()]) }, { additionalProperties: false }),
  NativeGitShowResult,
  Type.Object({ kind: Type.Literal('gitShowMetadata'), commit: NativeGitCommitInfo }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitShowError'), message: Type.String() }, { additionalProperties: false }),
  ...NativeReadTextResult.anyOf,
  NativeSelectionInputParsingResult,
  SelectionPathBindingsResult,
  SelectionHintResult,
  NativeSelectionReplyResult,
  ...NativeSelectionPreparationResult.anyOf,
  ...NativeSelectionPathMutationResult.anyOf,
  NativeSelectionCandidatesResult,
  Type.Object({ kind: Type.Literal('pathMatch'), match: Type.Union([Type.Object({ rootPath: Type.String(), correctedPath: Type.String() }, { additionalProperties: false }), Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('sliceRanges'), ranges: Type.Array(NativeSliceRange) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('selectionTransition'), selection: NativeSelectionState }, { additionalProperties: false }),
  NativeFileTreeResult,
  NativeStructureResult,
  Type.Object({ kind: Type.Literal('discoveryPrompt'), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('discoveryMessage'), text: Type.String() }, { additionalProperties: false }),
  ...NativeAskUserResult.anyOf,
  Type.Object({ kind: Type.Literal('description'), decoderPolicy: DecoderPolicy,
    regexEngineFingerprint: SHA256,
    engine: Type.Object({ version: Type.String(), unicode: Type.String(), jitPolicy: Type.Union([Type.Literal('disabled'), Type.Literal('auto'), Type.Literal('required')]), jitCapability: Type.Boolean(), jitExecution: Type.Union([Type.Literal('disabled'), Type.Literal('compiled'), Type.Literal('unavailable')]) }, { additionalProperties: false }),
    extensions: Type.Array(Type.Object({ extension: Type.String(), pipelineCanonicalBase64: base64 }, { additionalProperties: false })),
    limits: Type.Object({ lines: SafeCount, utf16Units: SafeCount, utf8Bytes: SafeCount }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('rootsOpened'), roots: Type.Array(Type.Object({
    handle, name: RootName, access, identity: RootIdentity,
  }, { additionalProperties: false })) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('directoryComplete'), count: SafeCount, sha256: SHA256 }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('sourceComplete'), identity: SourceIdentity,
    fingerprint: DescriptorFingerprint, key: Type.Union([ArtifactKey, Type.Null()]),
    decoding: Type.Union([
      Type.Object({ kind: Type.Literal('decoded'), text: Type.String(), identity: SourceIdentity, encoding: SafeCount }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('undecodable') }, { additionalProperties: false }),
    ]),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('extracted'), key: ArtifactKey,
    outcome: SyntaxOutcome, projection: Type.Union([Projection, Type.Null()]),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('unsupportedExtension') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('exportOpened'), run: handle }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('exportWritten'), identity: SourceIdentity }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('exportRead'), bytes: base64, identity: SourceIdentity }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('manifestPublished'), identity: SourceIdentity }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('failure'), code: NativeWireFailureCode, errno: Type.Union([Type.Integer(), Type.Null()]) }, { additionalProperties: false }),
]);
export type NativeResult = Static<typeof NativeResult>;
const envelope = { wireVersion: Type.Literal(1), requestId: Type.String({ minLength: 1 }), generation: Type.String({ minLength: 1 }) };
export const NativeFrame = Type.Union([
  Type.Object({ ...envelope, kind: Type.Literal('terminal'), result: NativeResult }, { additionalProperties: false }),
  Type.Object({ ...envelope, kind: Type.Literal('bytes'), bytes: base64 }, { additionalProperties: false }),
  Type.Object({ ...envelope, kind: Type.Literal('entry'), name: Type.String({ minLength: 1, pattern: '^[^/\\u0000]+$' }),
    entryKind: Type.Union([Type.Literal('file'), Type.Literal('directory'), Type.Literal('symlink'), Type.Literal('other')]),
  }, { additionalProperties: false }),
]);
export type NativeFrame = Static<typeof NativeFrame>;
export const nativeRequestValidator = Compile(NativeRequest);
export const nativeFrameValidator = Compile(NativeFrame);
