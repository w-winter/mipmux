import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { SelectionRequest } from '../contracts/selection.js';
import type { SourceSelection, CodemapMode } from '../contracts/context.js';
import type { InventorySnapshot } from '../contracts/inventory.js';
import type { NativeOperation, NativeResult } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import type { Material } from './material-store.js';
import { NativeFailure } from '../native/bridge-client.js';
import { contains } from '../workspace/root-policy.js';
import type { CatalogedGitArtifact } from '../workspace/git-artifact-catalog.js';
import { resolveGitArtifactSelection } from './git-artifact-selection.js';
import type { GitArtifactMaterial } from './git-artifact-material.js';

export type SelectionState = Extract<NativeOperation, { kind: 'prepareSelection' }>['selection'];
type Catalog = Extract<NativeOperation, { kind: 'prepareSelection' }>['catalog'];
type Parsed = Extract<NativeResult, { kind: 'selectionInputs' }>;
export type RootBinding = InventorySnapshot['roots'][number] & { readonly selectionPath: string };
export interface CanonicalSelection { readonly roots: readonly RootBinding[]; readonly state: SelectionState }
type PathRequest = SelectionRequest & { readonly op: 'add' | 'remove' | 'promote' | 'demote' };
interface SelectionPreparation { readonly state: SelectionState; readonly invalid: string[] }

function rootForPath(roots: readonly RootBinding[], path: string) {
  return roots.filter(root => contains(root.selectionPath, path))
    .sort((a, b) => b.selectionPath.length - a.selectionPath.length)[0];
}
function relativePath(root: RootBinding, path: string): string {
  return path === root.selectionPath ? '' : path.slice(root.selectionPath === '/' ? 1 : root.selectionPath.length + 1);
}
export function capturedState(roots: readonly RootBinding[], materials: ReadonlyMap<string, Material>, mode: CodemapMode): SelectionState {
  const state: SelectionState = { selectedPaths: [], manualCodemapPaths: [], slices: {}, codemapAutoEnabled: mode === 'automatic' };
  for (const { record } of materials.values()) {
    if (record.kind === 'gitMap' || record.kind === 'gitPatch') {
      state.selectedPaths.push(record.reference.absolutePath);
      continue;
    }
    if (record.kind !== 'source' || record.selectionOrigin !== 'explicit') continue;
    const root = roots.find(root => root.name === record.selection.source.root)!;
    const path = posix.join(root.selectionPath, record.selection.source.path);
    if (record.selection.kind === 'codemap') state.manualCodemapPaths.push(path);
    else {
      state.selectedPaths.push(path);
      if (record.selection.kind === 'slices') state.slices[path] = [...record.selection.ranges];
    }
  }
  return state;
}
export async function captureSelection(operation: WorkspaceOperation, materials: ReadonlyMap<string, Material>, mode: CodemapMode): Promise<CanonicalSelection> {
  const bindings = await operation.selectionPathBindings(operation.snapshot.roots.map(root => root.identity.canonicalPath));
  const roots = operation.snapshot.roots.map((root, index) => ({ ...root, selectionPath: bindings[index]! }));
  return { roots, state: capturedState(roots, materials, mode) };
}
export function selectionPath(roots: readonly RootBinding[], source: { readonly root: string; readonly path: string }): string {
  const root = roots.find(root => root.name === source.root);
  if (!root) throw new WorkspaceFailure('unknownRoot');
  return posix.join(root.selectionPath, source.path);
}
function validateIngress(request: SelectionRequest, parsed: Parsed): void {
  if (request.op === 'get' || request.op === 'clear') return;
  if (request.op === 'promote' || request.op === 'demote') {
    if (!parsed.paths.length) throw new WorkspaceFailure('invalidSelection', { message: 'paths required for ' + request.op });
    if (parsed.slices.length) throw new WorkspaceFailure('invalidSelection', { message: request.op + ' does not support slices' });
    return;
  }
  if ((request.op === 'add' || request.op === 'remove') && !parsed.paths.length && !parsed.slices.length) {
    throw new WorkspaceFailure('invalidSelection', { message: 'paths or slices required for ' + request.op });
  }
  if (request.mode === 'codemap_only' && parsed.slices.length) {
    throw new WorkspaceFailure('invalidSelection', { message: "mode 'codemap_only' cannot be used with slices" });
  }
}
async function materializePath(operation: WorkspaceOperation, roots: readonly RootBinding[], path: string, absolute: string) {
  if (!absolute.startsWith('/') || path.includes('\0')) return null;
  const root = rootForPath(roots, absolute);
  if (!root) return null;
  const relative = relativePath(root, absolute);
  const existing = operation.snapshot.entries.find(entry => entry.root === root.name && entry.path === relative);
  if (existing?.kind === 'file') return null;
  if (!relative || existing?.kind === 'directory') return { path, outcome: 'unavailable' as const };
  try {
    await operation.registerExplicitSource({ root: root.name, path: relative });
    return null;
  } catch (error) {
    if (error instanceof WorkspaceFailure && error.code === 'pathDenied') return { path, outcome: 'blocked' as const };
    if (error instanceof NativeFailure && ['notFound', 'permissionDenied', 'symlink', 'nonRegularFile'].includes(error.code)) {
      return { path, outcome: 'unavailable' as const };
    }
    throw error;
  }
}
async function capturedCatalog(operation: WorkspaceOperation, roots: readonly RootBinding[], parsed: Parsed): Promise<Catalog> {
  const materialization: Catalog['materialization'] = [];
  const paths = [...new Set([...parsed.paths, ...parsed.slices.map(slice => slice.path)])];
  const normalized = await operation.selectionPathBindings(paths);
  for (const [index, path] of paths.entries()) {
    const outcome = await materializePath(operation, roots, path, normalized[index]!);
    if (outcome) materialization.push(outcome);
  }
  const entries = operation.snapshot.entries;
  return { roots: roots.map(root => ({ id: randomUUID(), name: root.name, path: root.selectionPath,
    files: entries.filter(entry => entry.root === root.name && (entry.kind === 'file' || entry.kind === 'acquisitionFailed'))
      .map(entry => ({ path: entry.path, discoverable: entry.kind === 'acquisitionFailed' ||
        entry.kind === 'file' && entry.visibility === 'discoverable' })),
    directories: entries.filter(entry => entry.root === root.name && entry.kind === 'directory')
      .map(entry => ({ path: entry.path, discoverable: entry.kind === 'directory' && entry.visibility === 'discoverable' })),
  })), materialization };
}
async function replaceSelection(operation: WorkspaceOperation, request: SelectionRequest, parsed: Parsed, state: SelectionState, catalog: Catalog,
  hasFullFileArtifactInputs: boolean) {
  const result = await operation.prepareSelection({ kind: 'prepareSelection', selection: state, catalog,
    mutation: { kind: 'set', mode: request.mode, paths: parsed.paths, slices: parsed.slices,
      sliceErrors: parsed.sliceErrors, hasFullFileArtifactInputs } });
  if (result.kind !== 'selectionBuilt') throw new WorkspaceFailure('nativeProtocolError');
  if (request.op === 'set' && result.invalidPaths.length) {
    throw new WorkspaceFailure('invalidSelection', { message: 'Invalid selection inputs: ' + result.invalidPaths.join(', ') });
  }
  return { state: result.selection, invalid: [...result.invalidPaths, ...result.codemapUnavailable] };
}
async function mutatePaths(operation: WorkspaceOperation, request: PathRequest, parsed: Parsed, state: SelectionState, catalog: Catalog) {
  const invalid: string[] = [];
  if (!parsed.paths.length) return { state, invalid, resolved: false };
  const mutation = request.op === 'promote' || request.op === 'demote'
    ? { op: request.op, paths: parsed.paths, rawPaths: request.paths }
    : { op: request.op, mode: request.mode === 'codemap_only' ? 'codemap_only' as const : 'full' as const,
      paths: parsed.paths, rawPaths: request.paths };
  const result = await operation.mutateSelectionPaths({ kind: 'mutateSelectionPaths', selection: state, catalog, mutation });
  invalid.push(...result.invalidPaths);
  if ('codemapUnavailable' in result) invalid.push(...result.codemapUnavailable);
  const resolved = result.op === 'promote' || result.op === 'demote'
    ? result.validCandidateCount > 0 : result.mutated || Object.keys(result.resolvedMap).length > 0;
  if ((request.op === 'promote' || request.op === 'demote') && !resolved) {
    const combinedInvalid = [...new Set([...invalid, ...parsed.sliceErrors])];
    throw new WorkspaceFailure('invalidSelection', { message: combinedInvalid.length ? 'Invalid selection inputs: ' + combinedInvalid.join(', ')
      : await operation.selectionHint(request.paths, request.op) });
  }
  return { state: result.selection, invalid, resolved };
}
async function requireResolvedPaths(operation: WorkspaceOperation, request: PathRequest, parsed: Parsed, resolved: boolean,
  artifactInvalid: readonly string[]) {
  if (request.strict && !resolved && (parsed.paths.length || artifactInvalid.length)) {
    throw new WorkspaceFailure('invalidSelection', { message: artifactInvalid.length ? artifactInvalid.join('; ')
      : await operation.selectionHint(request.paths, request.op) });
  }
}
async function mutateSelection(operation: WorkspaceOperation, request: PathRequest, parsed: Parsed, state: SelectionState, catalog: Catalog,
  artifacts: Awaited<ReturnType<typeof resolveGitArtifactSelection>>) {
  const paths = await mutatePaths(operation, request, parsed, state, catalog);
  let next = paths.state, resolved = paths.resolved || artifacts.resolved.length > 0;
  const invalid = [...parsed.sliceErrors, ...paths.invalid];
  if (parsed.slices.length) {
    const result = await operation.prepareSelection({ kind: 'prepareSelection', selection: next, catalog,
      mutation: { kind: 'slices', op: request.op === 'remove' ? 'remove' : 'add', entries: parsed.slices } });
    if (result.kind !== 'selectionSlicesChanged') throw new WorkspaceFailure('nativeProtocolError');
    next = result.selection; invalid.push(...result.invalidPaths);
    resolved ||= result.mutated || Object.keys(result.resolvedMap).length > 0;
    if (request.strict && !resolved && !result.invalidPaths.length && (request.op === 'remove' || !parsed.paths.length)) {
      throw new WorkspaceFailure('invalidSelection', { message: 'Provided slices did not match any files' });
    }
  } else if (parsed.hadExplicitSliceSpec && request.strict && !artifacts.invalid.length && !(request.op === 'add' && request.mode === 'codemap_only')) {
    throw new WorkspaceFailure('invalidSelection', { message: parsed.sliceErrors.length ? parsed.sliceErrors.join('; ')
      : 'No valid slices parsed from provided specification' });
  }
  await requireResolvedPaths(operation, request, parsed, resolved, artifacts.invalid);
  return { state: next, invalid };
}
function selectedSources(roots: readonly RootBinding[], state: SelectionState, artifacts: ReadonlySet<string>): SourceSelection[] {
  const source = (path: string) => {
    const root = rootForPath(roots, path);
    if (!root) throw new WorkspaceFailure('nativeProtocolError');
    return { root: root.name, path: relativePath(root, path) };
  };
  const selections: SourceSelection[] = state.selectedPaths.filter(path => !artifacts.has(path)).map(path => state.slices[path]?.length
    ? { kind: 'slices', source: source(path), ranges: state.slices[path]! }
    : { kind: 'full', source: source(path) });
  const selected = new Set(state.selectedPaths);
  selections.push(...state.manualCodemapPaths.filter(path => !selected.has(path)).map(path => ({ kind: 'codemap' as const, source: source(path) })));
  return selections;
}
export function projectSelection(selection: CanonicalSelection, known: ReadonlyMap<string, GitArtifactMaterial>) {
  const { roots, state } = selection;
  return { state, selections: selectedSources(roots, state, new Set(known.keys())),
    artifactMaterials: state.selectedPaths.flatMap(path => { const material = known.get(path); return material ? [material] : []; }),
    mode: state.codemapAutoEnabled ? 'automatic' as const : 'manual' as const };
}
export async function prepareSelection(operation: WorkspaceOperation, request: SelectionRequest,
  materials: ReadonlyMap<string, Material>, selection: CanonicalSelection, grants: ReadonlyMap<string, CatalogedGitArtifact>) {
  const { roots, state } = selection;
  const parsed = await operation.parseSelectionInputs({ kind: 'parseSelectionInputs', paths: request.paths, slices: request.slices });
  validateIngress(request, parsed);
  const artifacts = await resolveGitArtifactSelection(operation, request, parsed, materials, grants);
  const ordinary = artifacts.ordinary;
  let prepared: SelectionPreparation;
  switch (request.op) {
    case 'get': prepared = { state, invalid: parsed.sliceErrors }; break;
    case 'clear': prepared = { state: request.mode === 'codemap_only'
      ? { ...state, manualCodemapPaths: [], codemapAutoEnabled: false }
      : { selectedPaths: [], manualCodemapPaths: [], slices: {}, codemapAutoEnabled: true }, invalid: parsed.sliceErrors }; break;
    case 'set': case 'preview': prepared = await replaceSelection(operation, request, ordinary, state,
      await capturedCatalog(operation, roots, ordinary), artifacts.resolved.length > 0); break;
    case 'add': case 'remove': case 'promote': case 'demote': prepared = await mutateSelection(operation,
      { ...request, op: request.op }, ordinary, state, await capturedCatalog(operation, roots, ordinary), artifacts); break;
  }
  if (artifacts.resolved.length) {
    const result = await operation.transitionSelection({ kind: 'transitionSelection', selection: prepared.state,
      mutation: { kind: 'fullFiles', op: request.op === 'remove' ? 'remove' : 'add',
        paths: artifacts.resolved.map(material => material.record.reference.absolutePath) } });
    prepared = { ...prepared, state: result.selection };
  }
  const invalid = [...new Set([...prepared.invalid, ...artifacts.invalid])];
  if (request.op === 'set' && invalid.length) throw new WorkspaceFailure('invalidSelection', { message: 'Invalid selection inputs: ' + invalid.join(', ') });
  const hintPaths = [...request.paths];
  for (const slice of parsed.slices) if (!hintPaths.includes(slice.path)) hintPaths.push(slice.path);
  return { ...projectSelection({ roots, state: prepared.state }, artifacts.known),
    usesInsertionGrant: request.op !== 'remove' && artifacts.resolved.length > 0,
    invalid,
    hintPaths };
}
