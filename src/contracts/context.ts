import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { InventorySnapshot, SourcePath, Exclusion, DecoderPolicy, SourceDecoding } from './inventory.js';
import { SafeCount, SHA256, SourceIdentity, RelativePath, RootName } from './workspace.js';
import { PatchInput, PatchReceipt } from './patches.js';
import { ArtifactKey } from './artifact.js';
import { Continuation } from './exploration.js';
import { ClipboardPreset, CopyContext, StoredPrompt, CapturedClipboardPreset, PromptSectionsOrder } from './presentation.js';
import { NativeFileTreeInput, NativeGitCheckout, AutomaticReviewGitCheckout, AutomaticReviewGitPathIssue, AutomaticReviewGitCompleteness } from './native.js';
import { AutomaticCodemapOutcome } from './automatic-codemaps.js';
import { Clarification } from './interaction.js';
import { UnreadableFileCode } from './errors.js';

const closed = { additionalProperties: false };
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const LineRange = Type.Object({ start: positive, end: positive, description: Type.Union([Type.String(), Type.Null()]) }, closed);
export type LineRange = Static<typeof LineRange>;
export const SourceSelection = Type.Union([
  Type.Object({ kind: Type.Literal('full'), source: SourcePath }, closed),
  Type.Object(
    { kind: Type.Literal('slices'), source: SourcePath, ranges: Type.Array(LineRange, { minItems: 1 }) },
    closed,
  ),
  Type.Object({ kind: Type.Literal('codemap'), source: SourcePath }, closed),
]);
export type SourceSelection = Static<typeof SourceSelection>;
/** Automatic mode derives one-hop related codemaps; manual mode retains explicit material only. */
export const CodemapMode = Type.Enum(['automatic', 'manual']);
export type CodemapMode = Static<typeof CodemapMode>;
/** Mutable starting selection; required evidence is declared separately. */
export const InitialSelection = Type.Union([
  Type.Object({ codemapMode: Type.Literal('automatic'), sources: Type.Array(Type.Union([SourceSelection.anyOf[0], SourceSelection.anyOf[1]])) }, closed),
  Type.Object({ codemapMode: Type.Literal('manual'), sources: Type.Array(SourceSelection) }, closed),
]);
const SuppliedDocument = Type.Object({
  kind: Type.Literal('suppliedDocument'),
  id: Type.String({ minLength: 1 }),
  role: Type.Enum(['plan', 'report', 'evidence']),
  origin: Type.String({ minLength: 1 }),
  text: Type.String(),
}, closed);
export const DocumentInput = Type.Union([
  Type.Object({
    kind: Type.Literal('localDocument'),
    id: Type.String({ minLength: 1 }),
    role: Type.Enum(['plan', 'report', 'evidence']),
    source: SourcePath,
  }, closed),
  SuppliedDocument,
]);
export type DocumentInput = Static<typeof DocumentInput>;
/** Captured discovery instructions: replacement, original plus additions, or unchanged original. */
export const PromptEnhancementMode = Type.Enum(['fullRewrite', 'augment', 'preserve']);
export type PromptEnhancementMode = Static<typeof PromptEnhancementMode>;
export const ContextBuildRequest = Type.Object({
  clarification: Type.Optional(Clarification),
  duplicateUserInstructionsAtTop: Type.Boolean(),
  includeDatetimeInUserInstructions: Type.Optional(Type.Boolean()),
  promptSectionsOrder: Type.Optional(PromptSectionsOrder),
  copyPreset: ClipboardPreset,
  storedPrompts: Type.Array(StoredPrompt),
  reviewGitBase: Type.Optional(Type.String({ pattern: '^[^\u0000]*$' })),
  contextBuilderPrompts: Type.Optional(Type.Array(Type.Object({ title: Type.String(), content: Type.String() }, closed))),
  task: Type.String(),
  constraints: Type.String(),
  enhancementMode: PromptEnhancementMode,
  purpose: Type.Enum(['planning', 'review', 'investigation']),
  initialSelection: InitialSelection,
  requiredSources: Type.Array(SourceSelection),
  documents: Type.Array(DocumentInput),
  patches: Type.Array(PatchInput),
  budgetUnits: SafeCount,
  discoveryHints: Type.Array(Type.String()),
  outputName: Type.String({ pattern: '^(?!\\.{1,2}$)[^/\\u0000]+$' }),
}, closed);
export type ContextBuildRequest = Static<typeof ContextBuildRequest>;
export const CapturedContextBuildRequest = Type.Object({ ...ContextBuildRequest.properties,
  copyPreset: CapturedClipboardPreset, copyPresetSelector: ClipboardPreset, copyContext: CopyContext }, closed);
export type CapturedContextBuildRequest = Static<typeof CapturedContextBuildRequest>;
const promptOperations = [
  Type.Object({ op: Type.Literal('set'), text: Type.String() }, closed),
  Type.Object({ op: Type.Literal('append'), text: Type.String() }, closed),
  Type.Object({ op: Type.Literal('clear') }, closed),
] as const;
export const PromptRequest = Type.Union([
  Type.Object({ op: Type.Literal('list_presets'), maxOutputBytes: positive }, closed),
  Type.Object({ op: Type.Literal('export'), path: Type.String(), copy_preset: Type.Optional(ClipboardPreset), maxOutputBytes: positive }, closed),
  Type.Object({ op: Type.Literal('get'), maxOutputBytes: positive }, closed),
  Type.Object({ ...promptOperations[0].properties, expectedRevision: SafeCount, maxOutputBytes: positive }, closed),
  Type.Object({ ...promptOperations[1].properties, expectedRevision: SafeCount, maxOutputBytes: positive }, closed),
  Type.Object({ ...promptOperations[2].properties, expectedRevision: SafeCount, maxOutputBytes: positive }, closed),
]);
export type PromptRequest = Static<typeof PromptRequest>;
export const SourceEdit = Type.Union([
  Type.Object({ kind: Type.Literal('upsert'), selection: SourceSelection }, closed),
  Type.Object({ kind: Type.Literal('remove'), source: SourcePath }, closed),
  Type.Object({ kind: Type.Literal('clearCodemaps') }, closed),
  Type.Object({ kind: Type.Literal('clearSources') }, closed),
]);
export type SourceEdit = Static<typeof SourceEdit>;
export const DraftUpdate = Type.Object({
  expectedRevision: SafeCount,
  maxOutputBytes: positive,
  mutation: Type.Union([
    ...SourceEdit.anyOf,
    Type.Object({ kind: Type.Literal('addDocument'), document: SuppliedDocument }, closed),
  ]),
}, closed);
export type DraftUpdate = Static<typeof DraftUpdate>;
const page = { maxOutputBytes: positive, continuation: Type.Union([Continuation, Type.Null()]) };
export const DraftInspection = Type.Union([
  Type.Object({ ...page, view: Type.Enum(['metadata', 'costs']) }, closed),
  Type.Object({ ...page, view: Type.Literal('material'), materialId: Type.String({ minLength: 1 }) }, closed),
]);
export type DraftInspection = Static<typeof DraftInspection>;
export const Span = Type.Object({ offset: SafeCount, length: SafeCount, sha256: SHA256 }, closed);
export type Span = Static<typeof Span>;
const sourceRecord = {
  kind: Type.Literal('source'), id: Type.String(), identity: SourceIdentity,
  mode: Type.Enum(['100644', '100755']), spans: Type.Array(Span), frame: Type.Union([Span, Type.Null()]),
};
const gitArtifactReference = Type.Object({ ownerID: Type.String({ format: 'uuid' }), checkout: NativeGitCheckout,
  snapshotID: RelativePath, snapshotDir: RelativePath, path: RelativePath, alias: RelativePath,
  absolutePath: Type.String({ pattern: '^/[^\\u0000]*$' }) }, closed);
const gitRecord = { id: Type.String(), reference: gitArtifactReference, identity: SourceIdentity, spans: Type.Array(Span) };
export const MaterialRecord = Type.Union([
  Type.Object({ ...sourceRecord,
    selectionOrigin: Type.Literal('explicit'),
    decoding: SourceDecoding.anyOf[0],
    required: Type.Boolean(),
    selection: SourceSelection,
    normalized: Type.Array(LineRange),
    artifactKey: Type.Union([Type.Null(), ArtifactKey]),
  }, closed),
  Type.Object({ ...sourceRecord,
    selectionOrigin: Type.Literal('explicit'), decoding: SourceDecoding.anyOf[1],
    required: Type.Literal(false), selection: SourceSelection.anyOf[2],
    normalized: Type.Tuple([]), artifactKey: ArtifactKey,
  }, closed),
  Type.Object({ ...sourceRecord,
    selectionOrigin: Type.Literal('inferred'), required: Type.Literal(false), decoding: SourceDecoding.anyOf[0],
    selection: SourceSelection.anyOf[2], normalized: Type.Tuple([]), artifactKey: ArtifactKey,
  }, closed),
  Type.Object({ ...sourceRecord,
    selectionOrigin: Type.Literal('presentation'), required: Type.Literal(false), decoding: SourceDecoding.anyOf[0],
    selection: SourceSelection.anyOf[2], normalized: Type.Tuple([]), artifactKey: ArtifactKey,
  }, closed),
  Type.Object({
    kind: Type.Literal('document'), id: Type.String(), input: DocumentInput.anyOf[0],
    identity: SourceIdentity, sourceIdentity: SourceIdentity, spans: Type.Array(Span), frame: Type.Union([Span, Type.Null()]),
  }, closed),
  Type.Object({
    kind: Type.Literal('document'), id: Type.String(), input: SuppliedDocument,
    identity: SourceIdentity, spans: Type.Array(Span), frame: Type.Union([Span, Type.Null()]),
  }, closed),
  Type.Object(
    { kind: Type.Literal('patch'), id: Type.String(), receipt: PatchReceipt, spans: Type.Array(Span) },
    closed,
  ),
  Type.Object({ ...gitRecord, kind: Type.Literal('gitMap'), frame: Type.Union([Span, Type.Null()]) }, closed),
  Type.Object({ ...gitRecord, kind: Type.Literal('gitPatch') }, closed),
]);
export type MaterialRecord = Static<typeof MaterialRecord>;
/** selectionIndex is the original zero-based position among explicit source selections. */
export const OmittedSource = Type.Object({ id: Type.String(), selection: SourceSelection,
  identity: SourceIdentity, mode: sourceRecord.mode, selectionIndex: SafeCount }, closed);
export type OmittedSource = Static<typeof OmittedSource>;
export const UnavailableRoot = Type.Object({ root: RootName,
  code: Type.Enum(['notFound', 'permissionDenied', 'rootChanged', 'nonRegularFile', 'symlink', 'nativeIOFailed']),
  sources: Type.Array(OmittedSource) }, closed);
export type UnavailableRoot = Static<typeof UnavailableRoot>;
/** codemapPending records historical readiness; manual I/O failures retain their observed pending/unmapped disposition. */
export const UnavailableFile = Type.Union([
  Type.Object({ ...OmittedSource.properties,
    selection: Type.Union([SourceSelection.anyOf[0], SourceSelection.anyOf[1]]), code: UnreadableFileCode }, closed),
  Type.Object({ ...OmittedSource.properties, selection: SourceSelection.anyOf[2],
    code: Type.Literal('codemapPending'), artifactKey: ArtifactKey }, closed),
  Type.Object({ ...OmittedSource.properties, selection: SourceSelection.anyOf[2], code: UnreadableFileCode,
    disposition: Type.Enum(['pending', 'unmapped']), artifactKey: ArtifactKey }, closed),
]);
export type UnavailableFile = Static<typeof UnavailableFile>;
const gitCommit = Type.String({ pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' });
const reviewComparison = Type.Object({ head: gitCommit, base: gitCommit }, closed);
const capturedReviewCheckout = { checkout: AutomaticReviewGitCheckout };
export const AutomaticReviewGitEvidence = Type.Object({ completeness: AutomaticReviewGitCompleteness,
  scope: Type.Enum(['selected', 'complete']),
  /** Directory binding for complete scope; null for selected scope or no active root. */
  rootBinding: Type.Union([Type.Null(), Type.Object({ kind: Type.Literal('worktree') }, closed),
    Type.Object({ kind: Type.Literal('gitDirectory'), path: Type.String({ pattern: '^/[^\u0000]*$' }) }, closed)]),
  sourceRoots: Type.Array(Type.Object({ root: RootName, path: Type.String({ pattern: '^/[^\u0000]*$' }) }, closed)),
  pathIssues: Type.Array(AutomaticReviewGitPathIssue), outcomes: Type.Array(Type.Union([
    Type.Object({ ...capturedReviewCheckout, kind: Type.Literal('diff'), comparison: reviewComparison, body: Span }, closed),
    Type.Object({ ...capturedReviewCheckout, kind: Type.Enum(['noChanges', 'commandFailed']), comparison: reviewComparison }, closed),
    Type.Object({ ...capturedReviewCheckout, kind: Type.Literal('baseResolutionFailed') }, closed),
  ])) }, closed);
export type AutomaticReviewGitEvidence = Static<typeof AutomaticReviewGitEvidence>;
export const ManualPresentation = Type.Object({ canonicalSources: Type.Array(SourceSelection), directlySelected: Type.Array(SourcePath),
  requested: Type.Array(SourcePath), ready: Type.Array(SourcePath), completeRootSet: Type.Boolean() }, closed);
export type ManualPresentation = Static<typeof ManualPresentation>;
export const Manifest = Type.Object({
  schemaVersion: Type.Literal(24),
  manualPresentation: Type.Union([ManualPresentation, Type.Null()]),
  codemapMode: CodemapMode,
  automaticCodemaps: Type.Array(AutomaticCodemapOutcome),
  request: CapturedContextBuildRequest,
  requestDigest: SHA256,
  inventory: Type.Omit(InventorySnapshot, ['generation']),
  exclusions: Type.Array(Exclusion),
  deniedAbsolutePaths: Type.Array(Type.String({ pattern: '^/[^\\u0000]*$' })),
  prompt: Type.String(),
  materials: Type.Array(MaterialRecord),
  unavailableRoots: Type.Array(UnavailableRoot),
  unavailableFiles: Type.Array(UnavailableFile),
  clipboardPreset: CapturedClipboardPreset,
  automaticGit: Type.Union([Type.Object({ evidence: AutomaticReviewGitEvidence, span: Type.Union([Span, Type.Null()]) }, closed), Type.Null()]),
  fileTree: Type.Object({ input: Type.Union([NativeFileTreeInput, Type.Null()]), span: Span }, closed),
  files: Type.Object({ context: SourceIdentity, handoff: SourceIdentity }, closed),
  accounting: Type.Object({
    recipient: Type.Literal('context.md'),
    method: Type.Literal('utf8-21-over-80-v1'),
    bytes: SafeCount,
    units: SafeCount,
    allowance: SafeCount,
    limitation: Type.Literal('Heuristic estimate; not an exact token count or provider acceptance guarantee.'),
  }, closed),
  checks: Type.Array(Type.String()),
  decoder: DecoderPolicy,
}, closed);
export type Manifest = Static<typeof Manifest>;
export const contextRequestValidator = Compile(ContextBuildRequest),
  updateValidator = Compile(DraftUpdate),
  inspectionValidator = Compile(DraftInspection),
  manifestValidator = Compile(Manifest);
