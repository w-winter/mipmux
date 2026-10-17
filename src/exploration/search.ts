import { searchValidator, type SearchRequest } from '../contracts/exploration.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { SourceIdentity } from '../contracts/workspace.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { pageIdentity, pageOffset } from './continuation.js';
import { pageResult, type ResultEncoding } from './output-budget.js';
import { prepareSearch } from './search-query.js';
import { searchContent } from './search-pass.js';
import { prepareSearchScope, refreshSearchScope } from './search-scope.js';

export interface SearchFile {
  readonly root: string; readonly path: string; readonly identity: SourceIdentity;
  readonly pathMatch: boolean;
  readonly matchingLines: number;
  readonly lines: readonly { number: number; text: string; matching: boolean }[];
}

export async function fileSearch(operation: WorkspaceOperation, request: SearchRequest, encode?: ResultEncoding) {
  if (!searchValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  const parsed = await prepareSearchScope(operation, request);
  return operation.withSearchOperation(request.continuation === null ? 'first' : 'continuation', async query => {
    const scope = await refreshSearchScope(query, request, parsed);
    return preparedSearch(query, request, scope, encode);
  });
}

async function preparedSearch(operation: WorkspaceOperation, request: SearchRequest,
  scope: Awaited<ReturnType<typeof refreshSearchScope>>, encode?: ResultEncoding) {
  const pattern = await prepareSearch(operation, request, scope.candidates);
  const { candidates, matchedPaths } = pattern;
  const { maxOutputBytes, continuation, ...settings } = request;
  const digest = pageIdentity(operation.snapshot, settings, candidates.map(entry => ({ root: entry.root, path: entry.path,
    identity: entry.identity })));
  const offset = pageOffset(continuation, digest);
  const { records, limitations, contentMatches, matchedFiles, correction } = await searchContent(operation, request, pattern, offset);
  const contentPattern = pattern.content.kind === 'ready' ? pattern.content.pattern : null;
  if (offset > matchedFiles) throw new WorkspaceFailure('invalidContinuation');
  const matchingLines = contentMatches;
  const counts = { totalMatches: matchingLines + matchedPaths.size, matchingLines, pathMatches: matchedPaths.size, matchedFiles };
  return pageResult(records, 0, maxOutputBytes, (files) => {
    const result = {
      kind: 'search' as const, inventoryDigest: operation.snapshot.inventoryDigest,
      scopedFileCount: scope.scopedFileCount, enumeration: operation.snapshot.enumeration, unavailableRoots: scope.unavailableRoots,
      engine: pattern.mode === 'path' ? 'RPCE path' : pattern.raw.isRegex || contentPattern?.isRegex === true ? 'PCRE2' : 'Foundation',
      newlineView: 'Original decoded text; CRLF, CR and LF define lines', counts,
      limitHit: !request.countOnly && (contentMatches >= request.maxResults || matchedPaths.size >= request.maxResults),
      returnedMatchingLines: files.reduce((sum, file) => sum + file.matchingLines, 0), files,
      limitations: [...scope.unavailable, ...limitations],
      truncated: !request.countOnly && offset + files.length < matchedFiles,
      continuation: request.countOnly || offset + files.length === matchedFiles ? null : { digest, offset: offset + files.length },
    };
    if (correction.kind === 'corrected') {
      return { ...result, warning: correction.warning };
    }
    return result;
  }, encode);
}
