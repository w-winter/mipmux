import { WorkspaceFailure } from '../workspace/values.js';

export type ReadShape = { readonly kind: 'whole' } |
  { readonly kind: 'range'; readonly start: number; readonly end: number } |
  { readonly kind: 'tail'; readonly count: number };
export interface SourceLine { readonly number: number; readonly offset: number; readonly length: number; readonly text: string }
export interface PreparedText { readonly lines: readonly SourceLine[]; readonly searchText: string }

export function prepareText(bytes: Uint8Array): PreparedText {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new WorkspaceFailure('decodeFailed'); }
  if (text.includes('\0')) throw new WorkspaceFailure('binarySource');
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 10 && bytes[index] !== 13) continue;
    if (bytes[index] === 13 && bytes[index + 1] === 10) index++;
    const end = index + 1;
    lines.push({ number: lines.length + 1, offset: start, length: end - start,
      text: Buffer.from(bytes.subarray(start, end)).toString('utf8') });
    start = end;
  }
  if (start < bytes.length) lines.push({ number: lines.length + 1, offset: start, length: bytes.length - start,
    text: Buffer.from(bytes.subarray(start)).toString('utf8') });
  return { lines, searchText: text.replace(/\r\n|\r/g, '\n') };
}

export function selectLines(prepared: PreparedText, shape: ReadShape) {
  let start = 1, end = prepared.lines.length;
  if (shape.kind === 'range') {
    start = shape.start; end = shape.end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > prepared.lines.length) {
      throw new WorkspaceFailure('invalidRange');
    }
  } else if (shape.kind === 'tail') {
    if (!Number.isSafeInteger(shape.count) || shape.count < 1) throw new WorkspaceFailure('invalidRange');
    start = Math.max(1, end - shape.count + 1);
  }
  const lines = prepared.lines.slice(start - 1, end);
  return { lines, range: lines.length ? { start, end } : null, text: lines.map(line => line.text).join('') };
}
