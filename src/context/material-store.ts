import type { DocumentInput, LineRange, MaterialRecord, SourceSelection } from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { ArtifactKey, InventoryEntry, SourcePath } from '../contracts/inventory.js';
import { descriptorGitMode } from '../contracts/patches.js';
import { prepareText } from '../exploration/lines.js';
import { canonicalJSON, freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
import { posix } from 'node:path';
import { documentBlockPath, parseSourceBlock, type SourceBlock } from './source-block.js';
import type { Static } from 'typebox';
import type { UnreadableFileCode } from '../contracts/errors.js';

export interface SettledMaterial {
  readonly availability: 'settled';
  readonly record: MaterialRecord;
  readonly bodies: readonly string[];
  readonly sourceBlock: SourceBlock | null;
}
type CodemapSelection = Extract<SourceSelection, { kind: 'codemap' }>;
interface PendingCodemapMaterial {
  readonly availability: 'pendingCodemap';
  readonly record: Extract<MaterialRecord, { kind: 'source' }> & {
    readonly selection: CodemapSelection;
    readonly normalized: []; readonly artifactKey: ArtifactKey;
  };
  readonly bodies: readonly [];
  readonly sourceBlock: null;
}
interface UnavailableCodemapMaterial {
  readonly availability: 'unavailableCodemap';
  readonly record: Extract<PendingCodemapMaterial['record'], { selectionOrigin: 'explicit' }>;
  readonly cause: Static<typeof UnreadableFileCode>;
  readonly disposition: 'pending' | 'unmapped';
  readonly bodies: readonly [];
  readonly sourceBlock: null;
}
export type Material = SettledMaterial | PendingCodemapMaterial | UnavailableCodemapMaterial;
export function sourceId(source: { root: string; path: string }): string {
  return 'source:' + canonicalJSON([source.root, source.path]);
}
export function strictText(text: string): string {
  if (Buffer.from(text).toString('utf8') !== text || text.includes('\0')) throw new WorkspaceFailure('invalidEncoding');
  return text;
}
export function identity(text: string | Buffer) {
  return { sha256: sha256(text), byteCount: Buffer.byteLength(text) };
}
export function normalizeRanges(ranges: readonly LineRange[], total: number): LineRange[] {
  if (
    !ranges.length ||
    ranges.some((range) =>
      !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 1 ||
      range.end < range.start || range.end > total
    )
  ) throw new WorkspaceFailure('invalidRange');
  const normalized: LineRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = normalized.at(-1);
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      if (last.description !== null && range.description !== null &&
        last.description.normalize('NFC') !== range.description.normalize('NFC')) last.description += '; ' + range.description;
      else last.description ??= range.description;
    } else normalized.push({ ...range });
  }
  return normalized;
}
export function codemapRepresentation(entry: InventoryEntry | undefined, source: SourcePath) {
  if (entry?.kind !== 'file' || entry.structural.kind !== 'artifact') return null;
  if (entry.structural.record.outcome.kind !== 'ready') return { kind: 'unmapped' as const, key: entry.structural.key };
  if (!entry.structural.record.projection) throw new WorkspaceFailure('invalidArtifact');
  return {
    kind: 'rendered' as const,
    key: entry.structural.key,
    body: [
      'File: ' + source.root + '/' + source.path,
      'Imports:',
      ...entry.structural.record.outcome.artifact.imports.map((value) => '  - ' + value),
    ].join('\n') + entry.structural.record.projection.apiDescription,
  };
}
type SourceAcquisition =
  | { readonly selectionOrigin: 'explicit'; readonly selection: SourceSelection; readonly required: boolean }
  | { readonly selectionOrigin: 'inferred'; readonly source: SourcePath };

async function acquireExplicitCodemap(operation: WorkspaceOperation, selection: Extract<SourceSelection, { kind: 'codemap' }>, required: boolean): Promise<Material> {
  await operation.materializeExplicitSource(selection.source);
  return captureExplicitCodemap(operation, selection, required);
}
export async function prepareCodemapSelection(operation: WorkspaceOperation, selection: CodemapSelection): Promise<Material> {
  await operation.registerExplicitSource(selection.source);
  return captureExplicitCodemap(operation, selection, false);
}
async function captureExplicitCodemap(operation: WorkspaceOperation, selection: CodemapSelection, required: boolean): Promise<Material> {
  const source = await operation.readRawSource(selection.source);
  const entry = operation.snapshot.entries.find(entry => entry.root === selection.source.root && entry.path === selection.source.path);
  if (entry?.kind === 'file' && entry.structural.kind === 'pending' && !required) {
    const fields: Omit<Extract<PendingCodemapMaterial['record'], { selectionOrigin: 'explicit' }>, 'decoding'> & { readonly required: false } = { kind: 'source', selectionOrigin: 'explicit', id: sourceId(selection.source),
      required: false, selection, identity: source.identity, mode: descriptorGitMode(source.fingerprint.mode),
      normalized: [], artifactKey: entry.structural.key, spans: [], frame: null };
    const record = entry.decoding.kind === 'decoded' ? { ...fields, decoding: entry.decoding } : { ...fields, decoding: entry.decoding };
    return freeze({ availability: 'pendingCodemap', record, bodies: [], sourceBlock: null });
  }
  const representation = codemapRepresentation(entry, selection.source);
  if (!representation) throw new WorkspaceFailure('codemapUnavailable', selection.source);
  const record = { kind: 'source' as const, selectionOrigin: 'explicit' as const, id: sourceId(selection.source), required,
    selection, identity: source.identity, mode: descriptorGitMode(source.fingerprint.mode), artifactKey: representation.key, spans: [], frame: null };
  if (source.decoding.kind === 'undecodable') {
    if (required) throw new WorkspaceFailure('decodeFailed', selection.source);
    if (representation.kind !== 'unmapped') throw new WorkspaceFailure('pipelineChanged', selection.source);
    return freeze({ availability: 'settled', record: { ...record, required: false, decoding: { kind: 'undecodable' as const }, normalized: [] }, bodies: [], sourceBlock: null });
  }
  const decoding = { kind: 'decoded' as const, identity: source.decoding.identity, encoding: source.decoding.encoding };
  return freeze({ availability: 'settled', record: { ...record, decoding, normalized: [] }, bodies: representation.kind === 'rendered' ? [representation.body] : [], sourceBlock: null });
}
export async function acquireSource(operation: WorkspaceOperation, input: SourceAcquisition): Promise<Material> {
  if (input.selectionOrigin === 'inferred') {
    const path = input.source;
    const source = await operation.readSource(path);
    const entry = operation.snapshot.entries.find(entry => entry.root === path.root && entry.path === path.path);
    const representation = codemapRepresentation(entry, path);
    if (representation?.kind !== 'rendered') throw new WorkspaceFailure('codemapUnavailable', path);
    return freeze({ availability: 'settled', record: { kind: 'source', id: sourceId(path), selectionOrigin: 'inferred', required: false,
      selection: { kind: 'codemap', source: path }, identity: source.identity,
      decoding: { kind: 'decoded', identity: source.decoding.identity, encoding: source.decoding.encoding }, mode: descriptorGitMode(source.fingerprint.mode),
      normalized: [], artifactKey: representation.key, spans: [], frame: null }, bodies: [representation.body], sourceBlock: null });
  }
  const { selection, required } = input;
  if (selection.kind === 'codemap') return acquireExplicitCodemap(operation, selection, required);
  const source = await operation.readSource(selection.source);
  const text = prepareText(source.text);
  const record: Extract<MaterialRecord, { kind: 'source'; selectionOrigin: 'explicit'; decoding: { kind: 'decoded' } }> = {
    kind: 'source',
    selectionOrigin: 'explicit',
    id: sourceId(selection.source),
    required,
    selection,
    identity: source.identity,
    decoding: { kind: 'decoded', identity: source.decoding.identity, encoding: source.decoding.encoding },
    mode: descriptorGitMode(source.fingerprint.mode),
    normalized: [],
    artifactKey: null,
    spans: [],
    frame: null,
  };
  if (selection.kind === 'slices') normalizeRanges(selection.ranges, text.lines.length);
  const block = await operation.projectNative({ kind: 'renderFileBlock', selectedPath: selection.source.root + '/' + selection.source.path,
    fileName: posix.basename(selection.source.path), content: source.text, ranges: selection.kind === 'slices' ? selection.ranges : null });
  const bodies = selection.kind === 'full' ? [source.text] : block.segments.map(segment => segment.text);
  if (selection.kind === 'slices') record.normalized = block.segments.map(({ start, end, description }) => ({ start, end, description }));
  return freeze({ availability: 'settled', record, bodies,
    sourceBlock: parseSourceBlock(record, { text: block.text, bodySpans: block.bodySpans }, bodies, new WorkspaceFailure('invalidSourceBlock')) });
}
export async function acquireDocument(operation: WorkspaceOperation, input: DocumentInput): Promise<Material> {
  let record: Extract<MaterialRecord, { kind: 'document' }>, text: string;
  if (input.kind === 'suppliedDocument') {
    strictText(input.origin);
    text = strictText(input.text);
    record = { kind: 'document', id: 'document:' + input.id, input, identity: identity(text), spans: [], frame: null };
  } else {
    const source = await operation.readSource(input.source);
    text = source.text;
    record = { kind: 'document', id: 'document:' + input.id, input, identity: identity(text),
      sourceIdentity: source.identity, spans: [], frame: null };
  }
  const path = documentBlockPath(record);
  const block = await operation.projectNative({ kind: 'renderFileBlock', selectedPath: path.path,
    fileName: path.name, content: text, ranges: null });
  return freeze({ availability: 'settled', record, bodies: [text],
    sourceBlock: parseSourceBlock(record, { text: block.text, bodySpans: block.bodySpans }, [text], new WorkspaceFailure('invalidSourceBlock')) });
}
