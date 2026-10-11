import type { ReadRequest } from '../contracts/exploration.js';
import { readValidator } from '../contracts/exploration.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { pageIdentity, pageOffset } from './continuation.js';
import { pageResult, type ResultEncoding } from './output-budget.js';

export async function readFile(operation: WorkspaceOperation, request: ReadRequest, encode?: ResultEncoding) {
  if (!readValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  const source = await operation.readSource({ root: request.root, path: request.path });
  const selection = await operation.sliceReadText({ kind: 'sliceReadText', text: source.text,
    start_line: request.start_line, offset: request.offset, limit: request.limit });
  if (selection.kind === 'readTextRangeError') throw new WorkspaceFailure(selection.code, { message: selection.message });
  const range = selection.lines.length ? { start: selection.firstLine, end: selection.lastLine } : null;
  const { maxOutputBytes, continuation, ...settings } = request;
  const digest = pageIdentity(operation.snapshot, settings, source.identity);
  return pageResult(selection.lines, pageOffset(continuation, digest), maxOutputBytes, (lines, next) => ({
    kind: 'read' as const, root: request.root, path: request.path, identity: source.identity,
    content: lines.map(line => line.text).join(''), totalLines: selection.totalLines, requestedRange: range,
    firstLine: lines[0]?.number ?? selection.firstLine, lastLine: lines.at(-1)?.number ?? selection.lastLine,
    returnedLineCount: lines.length, message: selection.message,
    returnedRange: lines.length ? { start: lines[0]!.number, end: lines[lines.length - 1]!.number } : null,
    lines, truncated: next !== null, continuation: next === null ? null : { digest, offset: next },
  }), encode);
}
