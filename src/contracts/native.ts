import { DecoderPolicy, IgnoreAuthority, IgnoreControl, IgnoreSettings } from './inventory.js';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { DirectoryRef, RelativePath, RootIdentity, RootName, SafeCount, SHA256, SourceIdentity } from './workspace.js';
import { ArtifactKey, Projection, Base64, SyntaxOutcome } from './artifact.js';
import { NativeGitReadQuery, NativeGitReadResult, NativeGitShowResult } from './git.js';
import { NativeWireFailureCode } from './errors.js';

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
}, { additionalProperties: false });
export const NativeFileTreeResult = Type.Object({ kind: Type.Literal('fileTree'), tree: Type.String(), rootsCount: SafeCount,
  note: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false });
export type NativeFileTreeResult = Static<typeof NativeFileTreeResult>;
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
export const NativeReadArgument = Type.Union([Type.Integer(), Type.String(), Type.Null()]);
export const NativeReadTextInput = Type.Object({ kind: Type.Literal('sliceReadText'), text: Type.String(),
  start_line: NativeReadArgument, offset: NativeReadArgument, limit: NativeReadArgument }, { additionalProperties: false });
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
const NativeGitChangedFile = Type.Object({ path: Type.String(), status: Type.String(),
  additions: Type.Union([Type.Integer(), Type.Null()]), deletions: Type.Union([Type.Integer(), Type.Null()]) }, { additionalProperties: false });
const NativeGitDiff = Type.Object({ compare: Type.String(), detail: Type.Optional(Type.String()),
  totals: Type.Object({ files: Type.Integer(), insertions: Type.Integer(), deletions: Type.Integer() }, { additionalProperties: false }),
  files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), status: Type.String(), insertions: Type.Optional(Type.Integer()),
    deletions: Type.Optional(Type.Integer()), hunks: Type.Optional(Type.Array(Type.Object({ header: Type.String(), old_start: Type.Integer(),
      new_start: Type.Integer(), patch: Type.String() }, { additionalProperties: false }))) }, { additionalProperties: false }))),
  by_status: Type.Optional(Type.Record(Type.String(), Type.Integer())), oneliner: Type.String(), truncated: Type.Optional(Type.Boolean()),
  truncation_note: Type.Optional(Type.String()) }, { additionalProperties: false });
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

export const NativeOperation = Type.Union([
  IgnoreCapture, IgnoreHierarchy,
  IgnoreQueryInput,
  NativeGitPatchInput,
  Type.Object({ kind: Type.Literal('parseGitComparison'), raw: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
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
  NativeSelectionInputParsingRequest,
  SelectionPathBindingsInput,
  SelectionHintInput,
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
  NativeIgnoreInputs,
  Type.Object({ kind: Type.Literal('ignoreHierarchy'), paths: Type.Array(Type.Union([
    Type.Object({ path: Type.String(), isDirectory: Type.Literal(false), ignored: Type.Boolean() }, { additionalProperties: false }),
    Type.Object({ path: Type.String(), isDirectory: Type.Literal(true), ignored: Type.Boolean(),
      requiresTraversal: Type.Boolean(), directoryIncluded: Type.Boolean() }, { additionalProperties: false }),
  ])), directories: IgnoreHierarchy.properties.directories }, { additionalProperties: false }),
  IgnoreQueryResult,
  NativeGitPatchResult,
  Type.Object({ kind: Type.Literal('gitComparison'), comparison: NativeGitComparison, rawKey: Type.String(), display: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('gitDiff'), diff: NativeGitDiff }, { additionalProperties: false }),
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
