import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { InventorySnapshot, SourcePath, Exclusion } from './inventory.js';
import { SafeCount, SHA256, SourceIdentity } from './workspace.js';
import { PatchInput, PatchReceipt } from './patches.js';
import { ArtifactKey } from './artifact.js';
import { Continuation } from './exploration.js';

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
  task: Type.String(),
  constraints: Type.String(),
  enhancementMode: PromptEnhancementMode,
  purpose: Type.Enum(['planning', 'review', 'investigation']),
  requiredSources: Type.Array(SourceSelection),
  documents: Type.Array(DocumentInput),
  patches: Type.Array(PatchInput),
  budgetUnits: SafeCount,
  discoveryHints: Type.Array(Type.String()),
  outputName: Type.String({ pattern: '^(?!\\.{1,2}$)[^/\\u0000]+$' }),
}, closed);
export type ContextBuildRequest = Static<typeof ContextBuildRequest>;
const promptOperations = [
  Type.Object({ op: Type.Literal('set'), text: Type.String() }, closed),
  Type.Object({ op: Type.Literal('append'), text: Type.String() }, closed),
  Type.Object({ op: Type.Literal('clear') }, closed),
] as const;
export const PromptRequest = Type.Union([
  Type.Object({ op: Type.Literal('get'), maxOutputBytes: positive }, closed),
  Type.Object({ ...promptOperations[0].properties, expectedRevision: SafeCount, maxOutputBytes: positive }, closed),
  Type.Object({ ...promptOperations[1].properties, expectedRevision: SafeCount, maxOutputBytes: positive }, closed),
  Type.Object({ ...promptOperations[2].properties, expectedRevision: SafeCount, maxOutputBytes: positive }, closed),
]);
export type PromptRequest = Static<typeof PromptRequest>;
export const SourceEdit = Type.Union([
  Type.Object({ kind: Type.Literal('upsert'), selection: SourceSelection }, closed),
  Type.Object({ kind: Type.Literal('remove'), source: SourcePath }, closed),
  Type.Object({ kind: Type.Literal('slices'), source: SourcePath, op: Type.Enum(['add', 'setPaths', 'remove']), ranges: Type.Array(LineRange) }, closed),
  Type.Object({ kind: Type.Literal('clearCodemaps') }, closed),
  Type.Object({ kind: Type.Literal('clearSources') }, closed),
]);
export type SourceEdit = Static<typeof SourceEdit>;
export const DraftPreview = Type.Object({ expectedRevision: SafeCount, maxOutputBytes: positive,
  edits: Type.Array(SourceEdit, { minItems: 1 }) }, closed);
export type DraftPreview = Static<typeof DraftPreview>;
export const DraftUpdate = Type.Object({
  expectedRevision: SafeCount,
  maxOutputBytes: positive,
  mutation: Type.Union([
    ...SourceEdit.anyOf,
    Type.Object({ kind: Type.Literal('batch'), edits: Type.Array(SourceEdit, { minItems: 1 }) }, closed),
    Type.Object({ kind: Type.Literal('prompt'), ...promptOperations[0].properties }, closed),
    Type.Object({ kind: Type.Literal('prompt'), ...promptOperations[1].properties }, closed),
    Type.Object({ kind: Type.Literal('prompt'), ...promptOperations[2].properties }, closed),
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
  mode: Type.Enum(['100644', '100755']), spans: Type.Array(Span),
};
export const MaterialRecord = Type.Union([
  Type.Object({ ...sourceRecord,
    selectionOrigin: Type.Literal('explicit'),
    required: Type.Boolean(),
    selection: SourceSelection,
    normalized: Type.Array(Type.Object({ start: positive, end: positive }, closed)),
    artifactKey: Type.Union([Type.Null(), ArtifactKey]),
  }, closed),
  Type.Object({ ...sourceRecord,
    selectionOrigin: Type.Literal('inferred'), required: Type.Literal(false),
    selection: SourceSelection.anyOf[2], normalized: Type.Tuple([]), artifactKey: ArtifactKey,
  }, closed),
  Type.Object({
    kind: Type.Literal('document'),
    id: Type.String(),
    input: DocumentInput,
    identity: SourceIdentity,
    spans: Type.Array(Span),
  }, closed),
  Type.Object(
    { kind: Type.Literal('patch'), id: Type.String(), receipt: PatchReceipt, spans: Type.Array(Span) },
    closed,
  ),
]);
export type MaterialRecord = Static<typeof MaterialRecord>;
export const Manifest = Type.Object({
  schemaVersion: Type.Literal(3),
  codemapMode: CodemapMode,
  request: ContextBuildRequest,
  requestDigest: SHA256,
  inventory: Type.Omit(InventorySnapshot, ['generation']),
  exclusions: Type.Array(Exclusion),
  deniedAbsolutePaths: Type.Array(Type.String({ pattern: '^/[^\\u0000]*$' })),
  prompt: Type.String(),
  materials: Type.Array(MaterialRecord),
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
  decoder: Type.Literal('smip-strict-utf8-v1'),
}, closed);
export type Manifest = Static<typeof Manifest>;
export const contextRequestValidator = Compile(ContextBuildRequest),
  updateValidator = Compile(DraftUpdate),
  inspectionValidator = Compile(DraftInspection),
  manifestValidator = Compile(Manifest);
