import type { ReadRequest } from '../contracts/exploration.js';
import { readValidator } from '../contracts/exploration.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { prepareText, selectLines } from './lines.js';
import { pageIdentity, pageOffset } from './continuation.js';
import { pageResult, type ResultEncoding } from './output-budget.js';

export async function readFile(operation: WorkspaceOperation, request: ReadRequest, encode?: ResultEncoding) {
  if (!readValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  const source = await operation.readSource({ root: request.root, path: request.path });
  const prepared = prepareText(source.bytes), selection = selectLines(prepared, request.shape);
  const { maxOutputBytes, continuation, ...settings } = request;
  const digest = pageIdentity(operation.snapshot, settings, source.identity);
  return pageResult(selection.lines, pageOffset(continuation, digest), maxOutputBytes, (lines, next) => ({
    kind: 'read' as const, root: request.root, path: request.path, identity: source.identity,
    totalLines: prepared.lines.length, requestedRange: selection.range,
    returnedRange: lines.length ? { start: lines[0]!.number, end: lines[lines.length - 1]!.number } : null,
    lines, truncated: next !== null, continuation: next === null ? null : { digest, offset: next },
  }), encode);
}
