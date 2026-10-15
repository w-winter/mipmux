import type { MaterialRecord, Span } from '../contracts/context.js';
import type { NativeOperation } from '../contracts/native.js';
import type { Material } from './material-store.js';
import type { SmipRuntime } from '../runtime/smip-runtime.js';
import type { RenderInput, ItemCost } from './render.js';
import { compareBytes, sha256, WorkspaceFailure } from '../workspace/values.js';
import { estimateUnits } from './budget.js';

type ClipboardInput = Extract<NativeOperation, { kind: 'renderPreparedClipboard' }>;
type PacketInput = Omit<RenderInput, 'clipboard' | 'clipboardPreset' | 'selectedGitDiffIds'>;

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
    copyPreset: input.request.copyPreset, storedPrompts: input.request.storedPrompts,
    codemapBlocks: materials.codemaps.flatMap(material => material.bodies),
    contentBlocks: materials.contents.map(contentBlock),
    fileTreeContent: input.fileTree.text,
    selectedGitDiffs: materials.selectedPatches.map(material => ({ id: material.record.id, text: material.bodies.join('') })),
    gitDiff: materials.patches.length ? materials.patches.flatMap(material => material.bodies).join('\n\n') : null,
    metaInstructions: input.request.constraints ? [{ title: 'Constraints', content: input.request.constraints }] : [],
    userInstructions: input.prompt,
  } };
}

export async function prepareClipboard(runtime: SmipRuntime, input: PacketInput, signal: AbortSignal): Promise<RenderInput> {
  const clipboard = await runtime.renderPresentation(preparedClipboardInput(input), signal);
  return { ...input, clipboard: clipboard.text, clipboardPreset: clipboard.preset, selectedGitDiffIds: clipboard.selectedGitDiffIds };
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

function consumeMetaInstructions(input: RenderInput, consume: Consume) {
  if (input.clipboardPreset.kind !== input.request.copyPreset) throw new WorkspaceFailure('invalidClipboard');
  const metas = input.request.storedPrompts.filter(prompt => input.clipboardPreset.storedPromptIds.some(id => id === prompt.id.toLowerCase()))
    .map(({ title, content }) => ({ title, content }));
  if (input.request.constraints) metas.push({ title: 'Constraints', content: input.request.constraints });
  for (const [index, meta] of metas.entries()) consume('<meta prompt ' + (index + 1) + ' = "' + meta.title + '">\n' + meta.content + '\n</meta prompt ' + (index + 1) + '>\n');
}

/** Reads source-default clipboard framing; never substitutes a TypeScript rendering for native assembly. */
export function parseClipboard(input: RenderInput) {
  const bytes = Buffer.from(input.clipboard), materials = partitionMaterials(input.materials);
  const includedGitDiffs = new Set(input.selectedGitDiffIds);
  const selectedPatches = input.clipboardPreset.gitInclusion === 'none' ? []
    : materials.selectedPatches.filter(material => includedGitDiffs.has(material.record.id));
  const patches = [...selectedPatches, ...materials.patches];
  const records: MaterialRecord[] = [], costs: ItemCost[] = [];
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
    records.push({ ...material.record, spans }); costs.push({ id: material.record.id, bytes: size, units: estimateUnits(size) });
  };
  const framed = (material: Material) => {
    const block = material.sourceBlock;
    if (!block || material.record.kind === 'patch' || material.record.kind === 'gitPatch') throw new WorkspaceFailure('invalidSourceBlock');
    const frame = consume(block.text);
    const spans = block.bodySpans.map((span, index) => ({ offset: frame.offset + span.offset, length: span.length,
      sha256: sha256(material.bodies[index]!) }));
    records.push({ ...material.record, frame, spans });
    costs.push({ id: material.record.id, bytes: frame.length, units: estimateUnits(frame.length) });
  };
  if (input.request.duplicateUserInstructionsAtTop && input.prompt) consume('<user_instructions>\n' + input.prompt + '\n</user_instructions>\n');
  const fileTreeSpan = consumeFileMap(input.fileTree.text, materials.codemaps, consume, raw);
  if (materials.contents.length) {
    consume('<file_contents>\n');
    consumeMaterialBlocks(materials.contents, consume, framed);
    consume('\n</file_contents>\n');
  }
  const gitDiff = patches.flatMap(material => material.bodies).join('\n\n');
  if (gitDiff) consume('<git_diff>\n');
  consumeMaterialBlocks(patches, consume, raw);
  if (gitDiff) consume('\n</git_diff>\n');
  consumeMetaInstructions(input, consume);
  if (input.prompt) consume('<user_instructions>\n' + input.prompt + '\n</user_instructions>\n');
  if (cursor !== bytes.length) throw new WorkspaceFailure('invalidClipboard');
  return { records, costs, fileTreeSpan };
}
