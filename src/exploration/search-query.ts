import type { SearchRequest } from '../contracts/exploration.js';
import type { InventoryEntry } from '../contracts/inventory.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';

export async function prepareSearch(operation: WorkspaceOperation, request: SearchRequest,
  candidates: Extract<InventoryEntry, { kind: 'file' }>[]) {
  const pattern = await operation.prepareSearchPattern({ kind: 'prepareSearchPattern', text: request.query.text,
    queryKind: request.query.kind === 'glob' ? 'literal' : request.query.kind,
    wholeWord: request.query.kind !== 'glob' && request.query.wholeWord, mode: request.mode });
  if (pattern.kind === 'searchPatternError') throw new WorkspaceFailure('invalidSearchPattern', { message: pattern.message });
  const roots = new Map(operation.snapshot.roots.map(root => [root.name, root.identity.canonicalPath]));
  const paths = await operation.matchSearchPaths({ kind: 'matchSearchPaths', mode: pattern.mode,
    pattern: pattern.path.text, isRegex: pattern.path.isRegex, caseSensitive: request.query.caseSensitive,
    limit: request.maxResults, files: candidates.map(file => {
      const rootPath = roots.get(file.root);
      if (!rootPath) throw new WorkspaceFailure('unknownRoot');
      return { root: file.root, path: file.path, rootPath };
    }) });
  if (paths.kind === 'searchPathsError') throw new WorkspaceFailure('searchFailed', { message: paths.message });
  if (paths.order.length !== candidates.length || new Set(paths.order).size !== candidates.length ||
    new Set(paths.matches).size !== paths.matches.length ||
    [...paths.order, ...paths.matches].some(index => index >= candidates.length)) throw new WorkspaceFailure('searchProtocolError');
  return { mode: pattern.mode, content: pattern.content,
    matchedPaths: new Set(paths.matches.map(index => candidates[index]!)),
    candidates: paths.order.map(index => candidates[index]!) };
}
