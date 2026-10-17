import type { SearchRequest } from '../contracts/exploration.js';
import type { NativeOperation } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { structureId } from '../workspace/structure-identity.js';
import { WorkspaceFailure } from '../workspace/values.js';

type CatalogRoots = Extract<NativeOperation, { kind: 'parseSearchScope' }>['roots'];
type ParsedScope = Awaited<ReturnType<WorkspaceOperation['resolveSearchScope']>>;

async function capture(operation: WorkspaceOperation, selectedRoots: readonly string[]) {
  const snapshot = operation.snapshot;
  const paths = await operation.selectionPathBindings(snapshot.roots.map(root => root.identity.canonicalPath));
  const roots: CatalogRoots = snapshot.roots.map((root, index) => ({ id: structureId(root.identity, null), name: root.name,
    path: paths[index]!, files: [], directories: [] }));
  const byName = new Map(roots.map(root => [root.name, root]));
  for (const entry of snapshot.entries) {
    const root = byName.get(entry.root)!;
    if (entry.kind === 'file' || entry.kind === 'acquisitionFailed') {
      root.files.push({ path: entry.path, discoverable: entry.kind === 'acquisitionFailed' || entry.visibility === 'discoverable' });
    } else if (entry.kind === 'directory') {
      root.directories.push({ path: entry.path, discoverable: entry.visibility === 'discoverable' });
    }
  }
  return { snapshot, roots, scoped: roots.filter(root => !selectedRoots.length || selectedRoots.includes(root.name)) };
}

export async function prepareSearchScope(operation: WorkspaceOperation, request: SearchRequest): Promise<ParsedScope | null> {
  if (!request.filters.paths.length) return null;
  const catalog = await capture(operation, request.filters.roots);
  return operation.resolveSearchScope({ kind: 'parseSearchScope', roots: catalog.scoped,
    paths: request.filters.paths, caseInsensitive: !request.query.caseSensitive });
}

async function refreshParsed(operation: WorkspaceOperation, request: SearchRequest, parsed: ParsedScope) {
  const catalog = await capture(operation, request.filters.roots);
  const scope = await operation.resolveSearchScope({ kind: 'refreshSearchScope', roots: catalog.scoped, scope: parsed });
  if (!scope.spec.clauses.length && scope.issues.length) {
    throw new WorkspaceFailure('invalidSearchScope', { message: scope.issues[0]! });
  }
  return { catalog, scope };
}

async function qualifyRoots(operation: WorkspaceOperation, roots: readonly { readonly name: string }[]) {
  const unavailableRoots: { root: string; code: string }[] = [];
  for (const root of roots) {
    const state = await operation.sourceRootAvailability(root.name);
    if (state.kind === 'unavailable') unavailableRoots.push({ root: root.name, code: state.code });
  }
  return unavailableRoots;
}

export async function refreshSearchScope(operation: WorkspaceOperation, request: SearchRequest, parsed: ParsedScope | null) {
  const resolved = parsed === null ? null : await refreshParsed(operation, request, parsed);
  const snapshot = operation.snapshot;
  const qualified = resolved?.scope.freshnessRootRefs ?? snapshot.roots
    .filter(root => !request.filters.roots.length || request.filters.roots.includes(root.name));
  const unavailableRoots = await qualifyRoots(operation, qualified);
  const unavailableNames = new Set(unavailableRoots.map(root => root.root));
  const admitted = snapshot.entries.filter(entry =>
    (entry.kind === 'file' && entry.visibility === 'discoverable' || entry.kind === 'acquisitionFailed') &&
    (!request.filters.roots.length || request.filters.roots.includes(entry.root)) &&
    !unavailableNames.has(entry.root));
  let matches = admitted;
  if (resolved) {
    const ids = new Map(resolved.catalog.roots.map(root => [root.name, root.id]));
    const filtered = await operation.filterSearchScope({ kind: 'filterSearchScope',
      roots: resolved.catalog.roots.map(({ id, name, path }) => ({ id, name, path })),
      files: admitted.map(file => ({ rootID: ids.get(file.root)!, path: file.path })), ...resolved.scope.spec });
    if (filtered.cancelled) throw new WorkspaceFailure('cancelled');
    if (new Set(filtered.indices).size !== filtered.indices.length || filtered.indices.some(index => index >= admitted.length)) {
      throw new WorkspaceFailure('searchProtocolError');
    }
    matches = filtered.indices.map(index => admitted[index]!);
  }
  return { candidates: matches.filter(entry => entry.kind === 'file'), scopedFileCount: matches.length, unavailableRoots,
    unavailable: matches.filter(entry => entry.kind === 'acquisitionFailed').map(entry => ({ root: entry.root, path: entry.path, code: entry.code })) };
}
