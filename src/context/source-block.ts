import { posix } from 'node:path';
import type { Static } from 'typebox';
import type { LineRange, MaterialRecord } from '../contracts/context.js';
import type { NativeFileBlockResult } from '../contracts/native.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';

export type SourceBlock = Pick<Static<typeof NativeFileBlockResult>, 'text' | 'bodySpans'>;

function sliceAnnotation(range: LineRange): string {
  const label = range.start === range.end ? String(range.start) : range.start + '-' + range.end;
  return '(lines ' + label + (range.description ? ': ' + range.description : '') + ')\n';
}

/** Parses native source framing and proves each raw body occupies its declared byte span. */
export function parseSourceBlock(record: Extract<MaterialRecord, { kind: 'source' }>, block: SourceBlock,
  bodies: readonly string[], failure: WorkspaceFailure): SourceBlock {
  const bytes = Buffer.from(block.text);
  let cursor = 0, bodyIndex = 0;
  const reject = (): never => { throw failure; };
  const consume = (text: string) => {
    const expected = Buffer.from(text);
    if (!bytes.subarray(cursor, cursor + expected.length).equals(expected)) reject();
    cursor += expected.length;
  };
  const body = () => {
    const span = block.bodySpans[bodyIndex], text = bodies[bodyIndex];
    if (!span || text === undefined || span.offset !== cursor || span.length !== Buffer.byteLength(text)) return reject();
    consume(text); bodyIndex++;
  };
  const source = record.selection.source;
  const extension = posix.extname(source.path).slice(1), fence = '```' + extension;
  consume('File: ' + source.root + '/' + source.path + '\n');
  if (record.selection.kind === 'full') {
    consume(fence + '\n'); body(); consume('\n```');
  } else if (record.selection.kind === 'slices') {
    for (const [index, range] of record.normalized.entries()) {
      if (index > 0) consume('\n');
      consume(sliceAnnotation(range) + fence + '\n');
      body(); consume('\n```');
      if (index < record.normalized.length - 1) consume('\n');
    }
  } else reject();
  if (cursor !== bytes.length || bodyIndex !== bodies.length || bodyIndex !== block.bodySpans.length) reject();
  return freeze(structuredClone(block));
}
