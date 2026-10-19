import type { SearchRequest } from '../contracts/exploration.js';
import type { InventoryEntry } from '../contracts/inventory.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import type { PreparedSearchPattern, SearchCorrection, SearchDiagnostic } from '../contracts/search-pattern.js';
import { SearchPatternFailure } from './search-diagnostic.js';

type ContentPreparation = { readonly kind: 'ready'; readonly pattern: PreparedSearchPattern; readonly correction: SearchCorrection }
  | { readonly kind: 'failed'; readonly diagnostic: SearchDiagnostic };

export async function prepareSearch(operation: WorkspaceOperation, request: SearchRequest,
  candidates: Extract<InventoryEntry, { kind: 'file' }>[]) {
  const pattern = await operation.prepareSearchPattern({ kind: 'prepareSearchPattern', text: request.query.text,
    queryKind: request.query.kind === 'glob' ? 'literal' : request.query.kind,
    wholeWord: request.query.kind !== 'glob' && request.query.wholeWord, mode: request.mode });
  if (pattern.kind === 'searchPatternError') throw new WorkspaceFailure('invalidSearchPattern', { message: pattern.message });
  const roots = new Map(operation.snapshot.roots.map(root => [root.name, root.identity.canonicalPath]));
  const paths = await operation.matchSearchPaths({ kind: 'matchSearchPaths', mode: pattern.mode,
    pattern: pattern.path.text, isRegex: pattern.path.isRegex, caseSensitive: request.query.caseSensitive,
    filters: { extensions: request.filters.extensions, exclude: request.filters.exclude },
    limit: request.maxResults, files: candidates.map(file => {
      const rootPath = roots.get(file.root);
      if (!rootPath) throw new WorkspaceFailure('unknownRoot');
      return { root: file.root, path: file.path, rootPath };
    }) });
  const matches = paths.kind === 'searchPaths' ? paths.matches : [];
  const pathError = paths.kind === 'searchPathsError' ? paths.diagnostic : null;
  const partition = [...paths.order, ...paths.excluded], included = new Set(paths.order);
  if (partition.length !== candidates.length || new Set(partition).size !== candidates.length ||
    new Set(matches).size !== matches.length ||
    partition.some(index => index >= candidates.length) || matches.some(index => !included.has(index))) {
    throw new WorkspaceFailure('searchProtocolError');
  }
  let content: ContentPreparation;
  if (pattern.kind === 'searchContentPatternError') {
    content = { kind: 'failed', diagnostic: pattern.diagnostic };
  } else if (pattern.mode !== 'path' && pattern.path.isRegex) {
    const compiled = await operation.compileRegexContent({ kind: 'compileRegexContent', pattern: pattern.path.text,
      caseSensitive: request.query.caseSensitive, wholeWord: request.query.kind !== 'glob' && request.query.wholeWord });
    if (compiled.kind === 'regexSearchError') {
      content = { kind: 'failed', diagnostic: compiled.diagnostic };
    } else {
      content = { kind: 'ready', pattern: pattern.content, correction: compiled.correction };
    }
  } else {
    content = { kind: 'ready', pattern: pattern.content, correction: { kind: 'unchanged' } };
  }
  if (content.kind === 'failed' && (pattern.mode === 'content' || pathError !== null)) {
    throw new SearchPatternFailure(content.diagnostic);
  }
  if (pattern.mode === 'path' && pathError !== null) throw new SearchPatternFailure(pathError);
  return { mode: pattern.mode, raw: pattern.path, content, pathError,
    matchedPaths: new Set(matches.map(index => candidates[index]!)),
    candidates: paths.order.map(index => candidates[index]!) };
}
