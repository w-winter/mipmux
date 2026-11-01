import Type, { type Static } from 'typebox';
import { SourcePath, WorkspaceSpec } from './inventory.js';
import { ContextBuildRequest, ContextPrepareRequest, DocumentInput, LineRange, type PromptEnhancementMode,
  type SourceSelection } from './context.js';
import { LocalComparison, PatchInput } from './patches.js';
import { DiscoverySelection } from './discovery.js';

/*
 * The compact inputs an MCP caller sends to build and prepare packets. Each expands once into the domain request that
 * drafts, jobs and saved manifests use, and the expansion fixes the fields a caller does not send.
 */
const closed = { additionalProperties: false };
const localPatch = PatchInput.anyOf[1].properties;
const { kind: _documentKind, ...documentFields } = DocumentInput.anyOf[1].properties;
const commitRef = Type.String({ minLength: 1 });
const [worktree, staged, commits] = LocalComparison.anyOf;
// Node's largest timer delay; a wait never exceeds it.
const maximumWaitMs = 2147483647;

/** The roots and existing output directory a call may use; omitted exclusions mean none. */
export const CallerWorkspace = Type.Object({ roots: WorkspaceSpec.properties.roots, outputRoot: WorkspaceSpec.properties.outputRoot,
  exclusions: Type.Optional(WorkspaceSpec.properties.exclusions) }, closed);
export type CallerWorkspace = Static<typeof CallerWorkspace>;
/** A file that must appear in full, or only its one-based inclusive `lines` ranges when they are present. */
export const CallerRequiredSource = Type.Object({ ...SourcePath.properties, lines: Type.Optional(Type.Array(
  Type.Object({ start: LineRange.properties.start, end: LineRange.properties.end }, closed), { minItems: 1 })) }, closed);
export type CallerRequiredSource = Static<typeof CallerRequiredSource>;
/** A local Git comparison whose base, and target for `commits`, are commit refs resolved when the patch is captured. */
export const CallerComparison = Type.Union([Type.Object({ ...worktree.properties, base: commitRef }, closed),
  Type.Object({ ...staged.properties, base: commitRef }, closed), Type.Object({ ...commits.properties, base: commitRef }, closed)]);
/** A complete patch for one root; omitted `paths` cover the whole comparison. */
export const CallerPatch = Type.Object({ id: localPatch.id, root: localPatch.root, comparison: CallerComparison,
  paths: Type.Optional(localPatch.scope.anyOf[1].properties.paths) }, closed);
export type CallerPatch = Static<typeof CallerPatch>;
/** Text from outside the roots, delivered unchanged; `origin` labels it and grants no read access. */
export const CallerDocument = Type.Object(documentFields, closed);
export type CallerDocument = Static<typeof CallerDocument>;
const evidence = { required: Type.Optional(Type.Array(CallerRequiredSource)), patches: Type.Optional(Type.Array(CallerPatch)),
  documents: Type.Optional(Type.Array(CallerDocument)) };
const build = ContextBuildRequest.properties, prepare = ContextPrepareRequest.properties;
export const CallerBuildRequest = Type.Object({ workspace: CallerWorkspace, purpose: build.purpose, task: build.task,
  outputName: build.outputName, ...evidence, copyPreset: Type.Optional(Type.Enum(['standard', 'codeReview'])),
  budgetUnits: build.budgetUnits, enhancementMode: build.enhancementMode, clarification: build.clarification,
  discovery: Type.Optional(DiscoverySelection) }, closed);
export type CallerBuildRequest = Static<typeof CallerBuildRequest>;
export const CallerPrepareRequest = Type.Object({ workspace: CallerWorkspace, bundle: prepare.bundle, prompt: prepare.prompt,
  outputName: prepare.outputName, refresh: prepare.refresh, ...evidence, remove: prepare.remove, demote: prepare.demote,
  budgetUnits: prepare.budgetUnits }, closed);
export type CallerPrepareRequest = Static<typeof CallerPrepareRequest>;
const jobId = Type.String({ minLength: 1 });
const durationMs = Type.Integer({ minimum: 0, maximum: maximumWaitMs, description: 'Required for wait and not accepted by the other operations.' });
/**
 * The advertised `context_job` input. Claude Code drops a tool whose schema composes alternatives at its root, so the
 * advertised shape is one object and `CallerJobRequest` states which operation takes which fields.
 */
const questionId = Type.String({ minLength: 1, description: 'Required for answer: the id of the question a wait returned.' });
/** An answer to a pending question: content keyed by the question schema's property names, or a decline that skips it. */
const QuestionAnswer = Type.Union([
  Type.Object({ action: Type.Literal('accept'), content: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])) }, closed),
  Type.Object({ action: Type.Literal('decline') }, closed),
], { description: 'Required for answer: {action:"accept", content} keyed by the question schema\'s property names, or {action:"decline"} to skip.' });
export const CallerJobInput = Type.Object({ op: Type.Enum(['wait', 'status', 'answer', 'cancel', 'dispose']), jobId,
  durationMs: Type.Optional(durationMs), questionId: Type.Optional(questionId), response: Type.Optional(QuestionAnswer) }, closed);
export type CallerJobInput = Static<typeof CallerJobInput>;
/** Only `wait` takes a duration and can deliver a pending question, and only `answer` answers one without a form. */
export const CallerJobRequest = Type.Union([
  Type.Object({ op: Type.Literal('wait'), jobId, durationMs }, closed),
  Type.Object({ op: Type.Literal('answer'), jobId, questionId, response: QuestionAnswer }, closed),
  Type.Object({ op: Type.Enum(['status', 'cancel', 'dispose']), jobId }, closed),
]);
export type CallerJobRequest = Static<typeof CallerJobRequest>;

function sourceSelection(source: CallerRequiredSource): SourceSelection {
  const path = { root: source.root, path: source.path };
  return source.lines === undefined ? { kind: 'full', source: path }
    : { kind: 'slices', source: path, ranges: source.lines.map(({ start, end }) => ({ start, end, description: null })) };
}

function patchInput(patch: CallerPatch): PatchInput {
  return { kind: 'localPatch', id: patch.id, root: patch.root,
    comparison: { ...patch.comparison, base: { kind: 'commit', ref: patch.comparison.base } },
    scope: patch.paths === undefined ? { kind: 'all' } : { kind: 'paths', paths: [...patch.paths] } };
}

function documentInput(document: CallerDocument): DocumentInput {
  return { kind: 'suppliedDocument', ...document };
}

/** The declaration in domain form, with omitted exclusions as an empty list; paths and order stay as supplied. */
export function expandCallerWorkspace(input: CallerWorkspace): WorkspaceSpec {
  return structuredClone({ roots: input.roots, exclusions: input.exclusions ?? [], outputRoot: input.outputRoot });
}

/**
 * The domain request for a caller's build. It starts from an empty automatic selection with no constraints or hints; the
 * preset defaults to codeReview for a review or any patch, and the budget and enhancement mode to the supplied host defaults.
 * The discovery selection is a job setting, not part of the domain request.
 */
export function expandCallerBuild(input: CallerBuildRequest, contextBudgetUnits: number,
  defaultEnhancementMode: PromptEnhancementMode): ContextBuildRequest {
  const { workspace: _workspace, discovery: _discovery, required = [], patches = [], documents = [], copyPreset, budgetUnits,
    enhancementMode, ...fields } = input;
  return { ...fields, constraints: '', initialSelection: { codemapMode: 'automatic', sources: [] }, discoveryHints: [],
    duplicateUserInstructionsAtTop: false, requiredSources: required.map(sourceSelection), documents: documents.map(documentInput),
    patches: patches.map(patchInput), copyPreset: copyPreset ?? (fields.purpose === 'review' || patches.length > 0 ? 'codeReview' : 'standard'),
    budgetUnits: budgetUnits ?? contextBudgetUnits, enhancementMode: enhancementMode ?? defaultEnhancementMode };
}

/** The domain request for a caller's preparation; omitted additions add nothing. */
export function expandCallerPrepare(input: CallerPrepareRequest): ContextPrepareRequest {
  const { workspace: _workspace, required = [], patches = [], documents = [], ...fields } = input;
  return { ...fields, requiredSources: required.map(sourceSelection), documents: documents.map(documentInput),
    patches: patches.map(patchInput) };
}
