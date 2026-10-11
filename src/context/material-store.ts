import type { DocumentInput, LineRange, MaterialRecord, SourceSelection } from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { InventoryEntry, SourcePath } from '../contracts/inventory.js';
import { descriptorGitMode } from '../contracts/patches.js';
import { prepareText } from '../exploration/lines.js';
import { canonicalJSON, freeze, sha256, WorkspaceFailure } from '../workspace/values.js';

export interface Material {
  readonly record: MaterialRecord;
  readonly bodies: readonly string[];
}
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
export function normalizeRanges(ranges: readonly LineRange[], total: number): { start: number; end: number }[] {
  if (
    !ranges.length ||
    ranges.some((range) =>
      !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 1 ||
      range.end < range.start || range.end > total
    )
  ) throw new WorkspaceFailure('invalidRange');
  const normalized: { start: number; end: number }[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = normalized.at(-1);
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else normalized.push({ start: range.start, end: range.end });
  }
  return normalized;
}
export function codemapRepresentation(entry: InventoryEntry | undefined, source: SourcePath) {
  if (entry?.kind !== 'file' || entry.structural.kind !== 'artifact' ||
    entry.structural.record.outcome.kind !== 'ready' || !entry.structural.record.projection) return null;
  return {
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

export async function acquireSource(operation: WorkspaceOperation, input: SourceAcquisition): Promise<Material> {
  const path = input.selectionOrigin === 'explicit' ? input.selection.source : input.source;
  const source = await operation.readSource(path);
  const text = prepareText(source.text);
  if (input.selectionOrigin === 'inferred') {
    const entry = operation.snapshot.entries.find(entry => entry.root === path.root && entry.path === path.path);
    const representation = codemapRepresentation(entry, path);
    if (!representation) throw new WorkspaceFailure('codemapUnavailable', path);
    return freeze({ record: { kind: 'source', id: sourceId(path), selectionOrigin: 'inferred', required: false,
      selection: { kind: 'codemap', source: path }, identity: source.identity, decodedIdentity: identity(source.text), mode: descriptorGitMode(source.fingerprint.mode),
      normalized: [], artifactKey: representation.key, spans: [] }, bodies: [representation.body] });
  }
  const { selection, required } = input;
  const record: Extract<MaterialRecord, { kind: 'source'; selectionOrigin: 'explicit' }> = {
    kind: 'source',
    selectionOrigin: 'explicit',
    id: sourceId(selection.source),
    required,
    selection,
    identity: source.identity,
    decodedIdentity: identity(source.text),
    mode: descriptorGitMode(source.fingerprint.mode),
    normalized: [],
    artifactKey: null,
    spans: [],
  };
  let bodies: string[];
  if (selection.kind === 'codemap') {
    const entry = operation.snapshot.entries.find((entry) =>
      entry.root === selection.source.root && entry.path === selection.source.path
    );
    const representation = codemapRepresentation(entry, selection.source);
    if (!representation) throw new WorkspaceFailure('codemapUnavailable', selection.source);
    record.artifactKey = representation.key;
    bodies = [representation.body];
  } else {
    if (selection.kind === 'full') bodies = [source.text];
    else {
      record.normalized = normalizeRanges(selection.ranges, text.lines.length);
      bodies = record.normalized.map((range) =>
        text.lines.slice(range.start - 1, range.end).map((line) => line.text).join('')
      );
    }
  }
  return freeze({ record, bodies });
}
export async function acquireDocument(operation: WorkspaceOperation, input: DocumentInput): Promise<Material> {
  if (input.kind === 'suppliedDocument') {
    strictText(input.origin);
    const text = strictText(input.text);
    return freeze({
      record: { kind: 'document', id: 'document:' + input.id, input, identity: identity(text), spans: [] },
      bodies: [text],
    });
  }
  const source = await operation.readSource(input.source);
  return freeze({
    record: { kind: 'document', id: 'document:' + input.id, input, identity: identity(source.text),
      sourceIdentity: source.identity, spans: [] },
    bodies: [source.text],
  });
}
