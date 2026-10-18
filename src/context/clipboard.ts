import type { MaterialRecord, Span } from '../contracts/context.js';
import type { NativeOperation } from '../contracts/native.js';
import type { Material } from './material-store.js';
import type { SmipRuntime } from '../runtime/smip-runtime.js';
import type { RenderInput, ItemCost } from './render.js';
import { compareBytes, sha256, WorkspaceFailure } from '../workspace/values.js';
import { estimateUnits } from './budget.js';
import { acquireAutomaticReviewGit, type AutomaticReviewGitSource } from './automatic-review-git.js';
import { verifyAutomaticReviewGitCapture } from './automatic-review-git-integrity.js';
import { defaultPromptSectionsOrder, type PromptSection } from '../contracts/presentation.js';

type ClipboardInput = Extract<NativeOperation, { kind: 'renderPreparedClipboard' }>;
type PacketInput = Omit<RenderInput, 'clipboard' | 'clipboardPreset' | 'selectedGitDiffIds' | 'tokenInputs'>;

function partitionMaterials(materials: readonly Material[]) {
  const sorted = [...materials].sort((a, b) => compareBytes(a.record.id, b.record.id));
  const codemaps = sorted.filter(material => material.record.kind === 'source' && material.record.selection.kind === 'codemap');
  const sources = sorted.filter(material => material.record.kind === 'source' && material.record.selection.kind !== 'codemap');
  const documents = sorted.filter(material => material.record.kind === 'document');
  const maps = materials.filter(material => material.record.kind === 'gitMap');
  const selectedPatches = materials.filter(material => material.record.kind === 'gitPatch');
  const patches = sorted.filter(material => material.record.kind === 'patch');
  return { codemaps, contents: [...maps, ...sources, ...documents], selectedPatches, patches };
}

function contentBlock(material: Material): string {
  if (!material.sourceBlock) throw new WorkspaceFailure('invalidSourceBlock');
  return material.sourceBlock.text;
}

/** Binds retained blocks and explicit caller instructions to the source clipboard assembly boundary. */
export function preparedClipboardInput(input: PacketInput): ClipboardInput {
  const materials = partitionMaterials(input.materials);
  return { kind: 'renderPreparedClipboard', input: {
    duplicateUserInstructionsAtTop: input.request.duplicateUserInstructionsAtTop,
    includeDatetimeInUserInstructions: input.request.includeDatetimeInUserInstructions ?? false,
    promptSectionsOrder: [...(input.request.promptSectionsOrder ?? defaultPromptSectionsOrder)],
    copyPreset: input.request.copyPreset, storedPrompts: input.request.storedPrompts,
    codemapBlocks: materials.codemaps.flatMap(material => material.bodies),
    contentBlocks: materials.contents.map(contentBlock),
    fileTreeContent: input.fileTree.text,
    selectedGitDiffs: materials.selectedPatches.map(material => ({ id: material.record.id, text: material.bodies.join('') })),
    gitDiff: materials.patches.length ? materials.patches.flatMap(material => material.bodies).join('\n\n') : null,
    automaticGitDiff: input.automaticGit?.text ?? null,
    metaInstructions: input.request.constraints ? [{ title: 'Constraints', content: input.request.constraints }] : [],
    userInstructions: input.prompt,
  } };
}

export async function prepareClipboard(runtime: SmipRuntime, input: Omit<PacketInput, 'automaticGit'>,
  signal: AbortSignal, source: AutomaticReviewGitSource): Promise<RenderInput> {
  let automaticGit = source.kind === 'captured' ? source.capture : null;
  let clipboard = await runtime.renderPresentation(preparedClipboardInput({ ...input, automaticGit }), signal);
  if (clipboard.needsAutomaticGit && source.kind === 'live') {
    const operation = await source.operation.fork(signal);
    try { automaticGit = await acquireAutomaticReviewGit(operation, input.request, input.materials, input.unavailableRoots, input.unavailableFiles); }
    finally { await operation.close(); }
    clipboard = await runtime.renderPresentation(preparedClipboardInput({ ...input, automaticGit }), signal);
  }
  return { ...input, automaticGit, clipboard: clipboard.text, clipboardPreset: clipboard.preset, selectedGitDiffIds: clipboard.selectedGitDiffIds,
    tokenInputs: clipboard.tokenInputs };
}

type Consume = (text: string) => Span;

function consumeMaterialBlocks(materials: readonly Material[], consume: Consume, visit: (material: Material) => void) {
  for (const [index, material] of materials.entries()) {
    if (index > 0) consume('\n\n');
    visit(material);
  }
}

function consumeFileMap(tree: string, codemaps: readonly Material[], consume: Consume, raw: (material: Material) => void): Span {
  const maps = codemaps.filter(material => material.bodies.length > 0);
  let span: Span = { offset: 0, length: 0, sha256: sha256('') };
  if (tree || maps.length) {
    consume('<file_map>\n');
    if (tree) span = consume(tree);
    if (tree && maps.length) consume('\n\n');
    consumeMaterialBlocks(maps, consume, raw);
    consume('\n</file_map>\n');
  }
  for (const material of codemaps.filter(material => material.bodies.length === 0)) raw(material);
  return span;
}

function consumeMetaInstructions(input: Omit<RenderInput, 'tokenInputs'>, consume: Consume) {
  if (input.clipboardPreset.kind !== input.request.copyPreset) throw new WorkspaceFailure('invalidClipboard');
  const metas = input.request.storedPrompts.filter(prompt => input.clipboardPreset.storedPromptIds.some(id => id === prompt.id.toLowerCase()))
    .map(({ title, content }) => ({ title, content }));
  if (input.request.constraints) metas.push({ title: 'Constraints', content: input.request.constraints });
  for (const [index, meta] of metas.entries()) consume('<meta prompt ' + (index + 1) + ' = "' + meta.title + '">\n' + meta.content + '\n</meta prompt ' + (index + 1) + '>\n');
}

function consumeGitDiff(input: Omit<RenderInput, 'tokenInputs'>, patches: readonly Material[], consume: Consume, raw: (material: Material) => void,
  charge: (id: string, bytes: number) => void): Span | null {
  const automaticText = input.automaticGit?.text ?? '';
  const gitDiff = [automaticText, ...patches.flatMap(material => material.bodies)].filter(Boolean).join('\n\n');
  if (gitDiff) consume('<git_diff>\n');
  const automaticSpan = automaticText ? consume(automaticText) : null;
  if (automaticSpan) {
    charge('automaticReviewGit', automaticSpan.length);
    if (patches.length) consume('\n\n');
  }
  consumeMaterialBlocks(patches, consume, raw);
  if (gitDiff) consume('\n</git_diff>\n');
  return automaticSpan;
}

function readInstructionDatetime(bytes: Buffer, offset: number): string {
  const end = bytes.indexOf('"', offset);
  if (end < 0) throw new WorkspaceFailure('invalidClipboard');
  const value = bytes.subarray(offset, end).toString('utf8');
  if (!/^\p{Decimal_Number}{4,}-\p{Decimal_Number}{2}-\p{Decimal_Number}{2}T\p{Decimal_Number}{2}:\p{Decimal_Number}{2}$/u.test(value)) {
    throw new WorkspaceFailure('invalidClipboard');
  }
  return value;
}

/** Uses only parser-proven header spans for clock-neutral comparison; material bytes remain exact. */
function withoutDatetimeValues(bytes: Buffer, spans: readonly Span[]): string {
  const parts: Buffer[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(bytes.subarray(cursor, span.offset));
    cursor = span.offset + span.length;
  }
  parts.push(bytes.subarray(cursor));
  return Buffer.concat(parts).toString('utf8');
}

/** Parses every ordered occurrence against canonical material bytes and charges all repetitions. */
export function parseClipboard(input: Omit<RenderInput, 'tokenInputs'>) {
  const bytes = Buffer.from(input.clipboard), materials = partitionMaterials(input.materials);
  const includedGitDiffs = new Set(input.selectedGitDiffIds);
  const selectedPatches = input.clipboardPreset.gitInclusion === 'none' ? []
    : materials.selectedPatches.filter(material => includedGitDiffs.has(material.record.id));
  const patches = [...selectedPatches, ...materials.patches];
  const records = new Map<string, MaterialRecord>(), costs = new Map<string, number>();
  const datetimeSpans: Span[] = [];
  const charge = (id: string, bytes: number) => { costs.set(id, (costs.get(id) ?? 0) + bytes); };
  let cursor = 0;
  const consume = (text: string): Span => {
    const expected = Buffer.from(text), offset = cursor;
    if (!bytes.subarray(cursor, cursor + expected.length).equals(expected)) throw new WorkspaceFailure('invalidClipboard');
    cursor += expected.length;
    return { offset, length: expected.length, sha256: sha256(text) };
  };
  const raw = (material: Material) => {
    const spans = material.bodies.map(body => consume(body));
    const size = spans.reduce((sum, span) => sum + span.length, 0);
    if (!records.has(material.record.id)) records.set(material.record.id, { ...material.record, spans });
    charge(material.record.id, size);
  };
  const framed = (material: Material) => {
    const block = material.sourceBlock;
    if (!block || material.record.kind === 'patch' || material.record.kind === 'gitPatch') throw new WorkspaceFailure('invalidSourceBlock');
    const frame = consume(block.text);
    const spans = block.bodySpans.map((span, index) => ({ offset: frame.offset + span.offset, length: span.length,
      sha256: sha256(material.bodies[index]!) }));
    if (!records.has(material.record.id)) records.set(material.record.id, { ...material.record, frame, spans });
    charge(material.record.id, frame.length);
  };
  verifyAutomaticReviewGitCapture(input.automaticGit, input.clipboardPreset.gitInclusion === 'selected' && selectedPatches.length === 0);
  const capturedSpans = new Map<'fileMap' | 'gitDiff', Span>();
  const sections = {
    fileMap: () => {
      const span = consumeFileMap(input.fileTree.text, materials.codemaps, consume, raw);
      if (!capturedSpans.has('fileMap')) capturedSpans.set('fileMap', span);
    },
    fileContents: () => {
      if (!materials.contents.length) return;
      consume('<file_contents>\n'); consumeMaterialBlocks(materials.contents, consume, framed); consume('\n</file_contents>\n');
    },
    gitDiff: () => {
      const span = consumeGitDiff(input, patches, consume, raw, charge);
      if (span && !capturedSpans.has('gitDiff')) capturedSpans.set('gitDiff', span);
    },
    metaPrompts: () => { consumeMetaInstructions(input, consume); },
    userInstructions: () => {
      if (!input.prompt) return;
      if (!input.request.includeDatetimeInUserInstructions) {
        consume('<user_instructions>\n' + input.prompt + '\n</user_instructions>\n'); return;
      }
      consume('<user_instructions date="');
      const date = readInstructionDatetime(bytes, cursor), first = datetimeSpans[0];
      if (first && date !== bytes.subarray(first.offset, first.offset + first.length).toString('utf8')) throw new WorkspaceFailure('invalidClipboard');
      datetimeSpans.push(consume(date));
      consume('">\n' + input.prompt + '\n</user_instructions>\n');
    },
  } satisfies Record<PromptSection, () => void>;
  if (input.request.duplicateUserInstructionsAtTop) sections.userInstructions();
  for (const section of input.request.promptSectionsOrder ?? defaultPromptSectionsOrder) sections[section]();
  const fileTreeSpan = capturedSpans.get('fileMap');
  if (!fileTreeSpan) throw new WorkspaceFailure('invalidClipboard');
  if (cursor !== bytes.length) throw new WorkspaceFailure('invalidClipboard');
  return { records: [...records.values()], costs: [...costs].map(([id, bytes]): ItemCost => ({ id, bytes, units: estimateUnits(bytes) })),
    fileTreeSpan, automaticGitSpan: capturedSpans.get('gitDiff') ?? null,
    comparisonText: datetimeSpans.length ? withoutDatetimeValues(bytes, datetimeSpans) : input.clipboard };
}
