import { treeValidator, type TreeRequest } from '../contracts/exploration.js';
import type { NativeFileTreeResult, NativeOperation } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { pageIdentity, pageOffset } from './continuation.js';
import { pageResult, type ResultEncoding } from './output-budget.js';

type TreeEntry = Extract<NativeOperation, { kind: 'renderFileTree' }>['entries'][number];
type FileTreeSettings = Pick<Extract<TreeRequest, { type: 'files' }>, 'selection' | 'scope' | 'mode' | 'maxDepth'>;

async function renderWorkspaceTree(operation: WorkspaceOperation, settings: FileTreeSettings, includeLegend: boolean) {
  const snapshot = operation.snapshot;
  const selected = new Set(settings.selection?.sources.map(source => JSON.stringify([source.root, source.path])));
  const entries = snapshot.entries.flatMap<TreeEntry>(entry => {
    if (entry.kind === 'directory') return [{ kind: 'directory' as const, root: entry.root, path: entry.path }];
    if (entry.kind !== 'file' && entry.kind !== 'acquisitionFailed') return [];
    const hasCodeMap = entry.kind === 'file' && entry.structural.kind === 'artifact' &&
      entry.structural.record.outcome.kind === 'ready' && entry.structural.record.projection !== undefined;
    return [{ kind: 'file' as const, root: entry.root, path: entry.path,
      selected: selected.has(JSON.stringify([entry.root, entry.path])), hasCodeMap }];
  });
  const scope = settings.scope === null ? null : { root: settings.scope.root,
    path: settings.scope.directory.kind === 'root' ? '' : settings.scope.directory.path };
  if (scope && (!snapshot.roots.some(root => root.name === scope.root) || scope.path && !snapshot.entries.some(entry =>
    entry.kind === 'directory' && entry.root === scope.root && entry.path === scope.path))) {
    throw new WorkspaceFailure('unavailableSource', scope);
  }
  return operation.renderFileTree({ kind: 'renderFileTree',
    roots: snapshot.roots.map(root => ({ name: root.name, path: root.name })), entries, scope,
    mode: settings.mode, maxDepth: settings.maxDepth, includeLegend, showFullPaths: false });
}

/** Renders the captured startup selection with RPCE's automatic view and available-codemap legend. */
export async function initialFileTree(operation: WorkspaceOperation, selection: FileTreeSettings['selection']): Promise<string> {
  return (await renderWorkspaceTree(operation, { mode: 'auto', scope: null, maxDepth: null, selection }, true)).tree;
}

export async function getFileTree(operation: WorkspaceOperation, request: TreeRequest, encode?: ResultEncoding) {
  if (!treeValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  const snapshot = operation.snapshot;
  const rendered: NativeFileTreeResult = request.type === 'roots'
    ? { kind: 'fileTree', tree: snapshot.roots.map(root => root.identity.canonicalPath).join('\n'), rootsCount: snapshot.roots.length, note: null }
    : await renderWorkspaceTree(operation, request, false);
  const lines = Array.from(rendered.tree.matchAll(/[^\n]*(?:\n|$)/g), match => match[0]).filter(line => line.length > 0);
  const { maxOutputBytes, continuation, ...settings } = request;
  const digest = pageIdentity(snapshot, settings, null);
  return pageResult(lines, pageOffset(continuation, digest), maxOutputBytes, (page, next) => ({
    kind: 'tree' as const, inventoryDigest: snapshot.inventoryDigest, type: request.type,
    tree: page.join(''), rootsCount: rendered.rootsCount, note: rendered.note,
    totalLines: lines.length, wasTruncated: next !== null, continuation: next === null ? null : { digest, offset: next },
  }), encode);
}
