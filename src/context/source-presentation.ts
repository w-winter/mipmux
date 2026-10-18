import { posix } from 'node:path';
import type { SelectionRequest } from '../contracts/selection.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { sourceId, type Material } from './material-store.js';
import { NativeFailure } from '../native/bridge-client.js';
import { unavailableRootCode } from '../workspace/source-access.js';
import { canonicalJSON, WorkspaceFailure } from '../workspace/values.js';
import { descriptorGitMode } from '../contracts/patches.js';

type SourceRecord = Extract<Material['record'], { kind: 'source' }>;
type RootAvailability = Awaited<ReturnType<WorkspaceOperation['sourceRootAvailability']>>;
type UnavailableSource =
  | { readonly kind: 'bodyUnavailable'; readonly record: SourceRecord; readonly code: NonNullable<ReturnType<typeof unavailableRootCode>> }
  | { readonly kind: 'notCataloged'; readonly record: SourceRecord; readonly code: 'unavailableSource' };

export async function unavailableSelectionRoots(operation: WorkspaceOperation, materials: ReadonlyMap<string, Material>): Promise<ReadonlySet<string>> {
  const roots = new Set([...materials.values()].flatMap(({ record }) => record.kind === 'source' ? [record.selection.source.root] : []));
  const unavailable = new Set<string>();
  for (const root of roots) if ((await operation.sourceRootAvailability(root)).kind === 'unavailable') unavailable.add(root);
  return unavailable;
}

export function selectionSourcePath(operation: WorkspaceOperation, record: SourceRecord, display: SelectionRequest['path_display']): string {
  const source = record.selection.source, root = operation.snapshot.roots.find(root => root.name === source.root)!;
  return display === 'full' ? posix.join(root.identity.canonicalPath, source.path)
    : operation.snapshot.roots.length === 1 ? source.path : root.name + '/' + source.path;
}

async function sourceBlock(operation: WorkspaceOperation, record: SourceRecord, bodies: readonly string[], path: string): Promise<
  { readonly kind: 'body'; readonly text: string } | { readonly kind: 'unavailable'; readonly code: NonNullable<ReturnType<typeof unavailableRootCode>> }
> {
  try {
    if (record.selection.kind === 'codemap') return { kind: 'body', text: bodies.join('') };
    let content = bodies.join('');
    if (record.selection.kind === 'slices') {
      const captured = await operation.readSource(record.selection.source);
      const decoding = { kind: captured.decoding.kind, identity: captured.decoding.identity, encoding: captured.decoding.encoding };
      if (canonicalJSON(captured.identity) !== canonicalJSON(record.identity) || descriptorGitMode(captured.fingerprint.mode) !== record.mode ||
        canonicalJSON(decoding) !== canonicalJSON(record.decoding)) throw new WorkspaceFailure('sourceChanged', record.selection.source);
      content = captured.text;
    }
    const block = await operation.renderFileBlock({ kind: 'renderFileBlock', selectedPath: path,
      fileName: posix.basename(record.selection.source.path), content, ranges: record.selection.kind === 'slices' ? record.selection.ranges : null });
    return { kind: 'body', text: block.text };
  } catch (error) {
    operation.signal.throwIfAborted();
    const code = error instanceof NativeFailure ? unavailableRootCode(error) : null;
    if (code === null) throw error;
    return { kind: 'unavailable', code };
  }
}

async function unavailableSource(operation: WorkspaceOperation, record: SourceRecord, catalog: ReadonlySet<string>,
  roots: Map<string, RootAvailability>): Promise<UnavailableSource | null> {
  if (!catalog.has(record.id)) return { kind: 'notCataloged', record, code: 'unavailableSource' };
  const name = record.selection.source.root;
  let root = roots.get(name);
  if (!root) { root = await operation.sourceRootAvailability(name); roots.set(name, root); }
  return root.kind === 'unavailable' ? { kind: 'bodyUnavailable', record, code: root.code } : null;
}

/** Keeps captured membership separate from readable bodies under the operation's pinned root identities. */
export async function captureSourcePresentation(operation: WorkspaceOperation, materials: readonly Material[], request: Pick<SelectionRequest, 'view' | 'path_display'>) {
  const roots = new Map<string, RootAvailability>();
  const catalog = new Set(operation.snapshot.entries.filter(entry => entry.kind === 'file').map(sourceId));
  const available: Material[] = [], unavailable: UnavailableSource[] = [], blocks = new Map<string, string>();
  for (const material of materials) {
    const record = material.record;
    if (record.kind !== 'source') { available.push(material); continue; }
    const failure = await unavailableSource(operation, record, catalog, roots);
    if (failure) { unavailable.push(failure); continue; }
    if (request.view === 'content' && material.bodies.length) {
      const block = await sourceBlock(operation, record, material.bodies, selectionSourcePath(operation, record, request.path_display));
      if (block.kind === 'unavailable') { unavailable.push({ kind: 'bodyUnavailable', record, code: block.code }); continue; }
      blocks.set(record.id, block.text);
    }
    available.push(material);
  }
  return { materials: available, unavailable, blocks };
}
