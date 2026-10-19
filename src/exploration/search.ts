import { searchValidator, type SearchRequest } from '../contracts/exploration.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { SourceIdentity } from '../contracts/workspace.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { pageIdentity, pageOffset } from './continuation.js';
import { pageResult, type ResultEncoding } from './output-budget.js';
import { prepareSearch } from './search-query.js';
import { searchContent } from './search-pass.js';
import { prepareSearchScope, refreshSearchScope } from './search-scope.js';
import { projectSearchReply } from './search-reply.js';
import { SearchPatternFailure } from './search-diagnostic.js';
import type { SearchDiagnostic } from '../contracts/search-pattern.js';

export interface SearchFile {
  readonly root: string; readonly path: string; readonly identity: SourceIdentity;
  readonly pathMatch: boolean;
  readonly matchingLines: number;
  readonly lines: readonly { number: number; text: string; matching: boolean }[];
}

interface SearchDiagnostics {
  suggestion?: string;
  pathError?: SearchDiagnostic;
  contentError?: SearchDiagnostic;
}

export async function fileSearch(operation: WorkspaceOperation, request: SearchRequest, encode?: ResultEncoding) {
  if (!searchValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  const parsed = await prepareSearchScope(operation, request);
  return operation.withSearchOperation(request.continuation === null ? 'first' : 'continuation', async query => {
    const scope = await refreshSearchScope(query, request, parsed);
    try {
      return await preparedSearch(query, request, scope, encode);
    } catch (error) {
      if (!(error instanceof SearchPatternFailure)) throw error;
      if (error.diagnostic.kind === 'rejected') {
        throw new WorkspaceFailure('invalidSearchPattern', { message: error.diagnostic.message });
      }
      const { issue, suggestion } = error.diagnostic;
      const advice: SearchDiagnostics = {};
      if (suggestion !== null) advice.suggestion = suggestion;
      return pageResult([], 0, request.maxOutputBytes, () => ({
        kind: 'search' as const, inventoryDigest: query.snapshot.inventoryDigest,
        scopedFileCount: scope.scopedFileCount, enumeration: query.snapshot.enumeration, unavailableRoots: scope.unavailableRoots,
        counts: { totalMatches: 0, matchingLines: 0, pathMatches: 0, totalFiles: 0, matchedFiles: 0 },
        pathMatchLines: [], limitHit: false, sizeLimitHit: false, omittedContentMatches: 0, omittedPathMatches: 0,
        perFileTotals: [], returnedMatchingLines: 0, files: [], perFileErrors: [], limitations: scope.unavailable,
        error: issue, ...advice, truncated: false, continuation: null,
      }), encode);
    }
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
  const scanned = await searchContent(operation, request, pattern);
  const { limitations, correction } = scanned;
  const projected = await projectSearchReply(operation, request, scanned, matchedPaths);
  const { records, contentMatches, pathMatches, totalFiles, matchedFiles, ...display } = projected;
  const contentPattern = pattern.content.kind === 'ready' ? pattern.content.pattern : null;
  if (offset > records.length) throw new WorkspaceFailure('invalidContinuation');
  const matchingLines = contentMatches;
  const counts = { totalMatches: matchingLines + pathMatches, matchingLines, pathMatches, totalFiles, matchedFiles };
  const diagnostics: SearchDiagnostics = {};
  if (pattern.pathError !== null) diagnostics.pathError = pattern.pathError;
  if (scanned.contentError !== null) diagnostics.contentError = scanned.contentError;
  if (request.filters.paths.length > 0 && scope.scopedFileCount === 0) {
    diagnostics.suggestion = 'The specified path filter resolved to no files in the current workspace. Use get_file_tree to inspect the project structure and confirm the path.';
  }
  return pageResult(records, offset, maxOutputBytes, (files, next) => {
    const result = {
      kind: 'search' as const, inventoryDigest: operation.snapshot.inventoryDigest,
      scopedFileCount: scope.scopedFileCount, enumeration: operation.snapshot.enumeration, unavailableRoots: scope.unavailableRoots,
      searchedFiles: candidates.length,
      engine: pattern.mode === 'path' ? 'RPCE path' : pattern.raw.isRegex || contentPattern?.isRegex === true ? 'PCRE2' : 'Foundation',
      newlineView: 'Original decoded text; CRLF, CR and LF define lines', counts,
      ...display,
      returnedMatchingLines: files.reduce((sum, file) => sum + file.matchingLines, 0), files,
      limitations: [...scope.unavailable, ...limitations],
      perFileErrors: scanned.perFileErrors,
      ...diagnostics,
      truncated: next !== null,
      continuation: next === null ? null : { digest, offset: next },
    };
    if (correction.kind === 'corrected') {
      return { ...result, warning: correction.warning };
    }
    return result;
  }, encode);
}
