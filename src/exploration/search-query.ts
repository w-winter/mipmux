import type { SearchRequest } from '../contracts/exploration.js';
import type { InventoryEntry } from '../contracts/inventory.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import type { PreparedSearchPattern } from '../contracts/search-pattern.js';

type ContentPreparation = { readonly kind: 'ready'; readonly pattern: PreparedSearchPattern }
  | { readonly kind: 'failed' };

export async function prepareSearch(operation: WorkspaceOperation, request: SearchRequest,
  candidates: Extract<InventoryEntry, { kind: 'file' }>[]) {
  const pattern = await operation.prepareSearchPattern({ kind: 'prepareSearchPattern', text: request.query.text,
    queryKind: request.query.kind === 'glob' ? 'literal' : request.query.kind,
    wholeWord: request.query.kind !== 'glob' && request.query.wholeWord, mode: request.mode });
  if (pattern.kind === 'searchPatternError') throw new WorkspaceFailure('invalidSearchPattern', { message: pattern.message });
  if (pattern.kind === 'searchContentPatternError' && pattern.mode === 'content') {
    throw new WorkspaceFailure('invalidSearchPattern', { message: pattern.message });
  }
  const roots = new Map(operation.snapshot.roots.map(root => [root.name, root.identity.canonicalPath]));
  const paths = await operation.matchSearchPaths({ kind: 'matchSearchPaths', mode: pattern.mode,
    pattern: pattern.path.text, isRegex: pattern.path.isRegex, caseSensitive: request.query.caseSensitive,
    filters: { extensions: request.filters.extensions, exclude: request.filters.exclude },
    limit: request.maxResults, files: candidates.map(file => {
      const rootPath = roots.get(file.root);
      if (!rootPath) throw new WorkspaceFailure('unknownRoot');
      return { root: file.root, path: file.path, rootPath };
    }) });
  if (paths.kind === 'searchPathsError') throw new WorkspaceFailure('searchFailed', { message: paths.message });
  const partition = [...paths.order, ...paths.excluded], included = new Set(paths.order);
  if (partition.length !== candidates.length || new Set(partition).size !== candidates.length ||
    new Set(paths.matches).size !== paths.matches.length ||
    partition.some(index => index >= candidates.length) || paths.matches.some(index => !included.has(index))) {
    throw new WorkspaceFailure('searchProtocolError');
  }
  const content: ContentPreparation = pattern.kind === 'searchContentPatternError'
    ? { kind: 'failed' } : { kind: 'ready', pattern: pattern.content };
  return { mode: pattern.mode, raw: pattern.path, content,
    matchedPaths: new Set(paths.matches.map(index => candidates[index]!)),
    candidates: paths.order.map(index => candidates[index]!) };
}
