import type { SourceSelection } from '../contracts/context.js';
import type { InventoryEntry, InventorySnapshot } from '../contracts/inventory.js';
import { posix } from 'node:path';
import { compareBytes } from '../workspace/values.js';
import { sourceId } from './material-store.js';
import { estimateUnits } from './budget.js';

// RPCE CodeMapExtractor+Snapshots.swift automatic overview policy.
const treeBudgetUnits = 6000, siblingCap = 100, overviewDepth = 3;
type View = 'full' | 'folders' | 'selected';
type Marker = '' | ' *' | ' +';
interface Leaf { readonly kind: 'file'; readonly name: string; readonly marker: Marker }
interface Folder {
  readonly kind: 'folder'; readonly name: string; readonly selected: boolean;
  readonly folders: Map<string, Folder>; readonly files: Leaf[];
}
type Node = Folder | Leaf;

function initialTreeRoots(snapshot: Pick<InventorySnapshot, 'roots' | 'entries'>,
  selections: readonly SourceSelection[]): Folder[] {
  const markers = new Map<string, Marker>(), selectedFolders = new Set<string>();
  for (const selection of selections) {
    const { source } = selection;
    markers.set(sourceId(source), selection.kind === 'codemap' ? ' +' : ' *');
    if (selection.kind === 'codemap') continue;
    const parts = source.path.split('/');
    for (let length = 0; length < parts.length; length++) {
      selectedFolders.add(sourceId({ root: source.root, path: parts.slice(0, length).join('/') }));
    }
  }
  const entriesByRoot = new Map<string, InventoryEntry[]>();
  for (const entry of snapshot.entries) {
    const entries = entriesByRoot.get(entry.root) ?? [];
    entries.push(entry); entriesByRoot.set(entry.root, entries);
  }
  return snapshot.roots.map(root => {
    const makeFolder = (name: string, path: string): Folder => ({ kind: 'folder', name,
      selected: selectedFolders.has(sourceId({ root: root.name, path })), folders: new Map(), files: [] });
    const node = makeFolder(root.name, '');
    for (const entry of entriesByRoot.get(root.name) ?? []) {
      if (entry.kind === 'skipped') continue;
      const parts = entry.path.split('/'), folderParts = entry.kind === 'directory' ? parts : parts.slice(0, -1);
      let parent = node;
      for (const [index, part] of folderParts.entries()) {
        let folder = parent.folders.get(part);
        if (!folder) { folder = makeFolder(part, folderParts.slice(0, index + 1).join('/')); parent.folders.set(part, folder); }
        parent = folder;
      }
      if (entry.kind !== 'directory') parent.files.push({ kind: 'file', name: posix.basename(entry.path), marker: markers.get(sourceId(entry)) ?? '' });
    }
    return node;
  });
}

/** Initial overview only. Its view reduction never changes admitted or selected material. */
export function renderInitialTree(snapshot: Pick<InventorySnapshot, 'roots' | 'entries'>,
  selections: readonly SourceSelection[]): string {
  const roots = initialTreeRoots(snapshot, selections);
  const hasSelection = selections.some(selection => selection.kind !== 'codemap');
  const selectedNote = hasSelection ? ['selected files shown'] : [];
  const attempts: { view: View; depth: number | null; notes: string[] }[] = [
    { view: 'full', depth: null, notes: [] },
    { view: 'full', depth: overviewDepth, notes: ['depth cap 3'] },
    { view: 'folders', depth: null, notes: ['directory-only view', ...selectedNote] },
    { view: 'folders', depth: overviewDepth, notes: ['directory-only view', 'depth cap 3', ...selectedNote] },
    { view: 'selected', depth: null, notes: ['selected-only view'] },
  ];
  for (const attempt of attempts) {
    const rendered = renderAttempt(roots, attempt.view, attempt.depth);
    if (!rendered) continue;
    const legends: string[] = [];
    if (rendered.markers.has(' *')) legends.push('(* denotes selected files)');
    if (rendered.markers.has(' +')) legends.push('(+ denotes a delivered codemap)');
    let text = rendered.text;
    if (legends.length) text += '\n\n' + legends.join('\n');
    if (attempt.notes.length) text += (legends.length ? '\n' : '\n\n') + 'Config: ' + attempt.notes.join('; ') + '.';
    return text;
  }
  return roots.map(root => root.name).join('\n');
}

function isSelected(node: Node): boolean { return node.kind === 'folder' ? node.selected : node.marker === ' *'; }
function children(folder: Folder, view: View): Node[] {
  const nodes: Node[] = [...folder.folders.values(), ...folder.files];
  return nodes.filter(node => view === 'selected' ? isSelected(node) : view === 'folders' ? node.kind === 'folder' || isSelected(node) : true)
    .sort((a, b) => a.kind !== b.kind ? a.kind === 'folder' ? -1 : 1 : compareBytes(a.name, b.name));
}

function prioritized(nodes: readonly Node[]): Node[] {
  const selectedFolders = nodes.filter(node => node.kind === 'folder' && node.selected);
  const otherFolders = nodes.filter(node => node.kind === 'folder' && !node.selected);
  const selectedFiles = nodes.filter(node => node.kind === 'file' && isSelected(node));
  const otherFiles = nodes.filter(node => node.kind === 'file' && !isSelected(node));
  return [...selectedFolders, ...otherFolders, ...selectedFiles, ...otherFiles]
    .slice(0, Math.max(siblingCap, selectedFolders.length + selectedFiles.length));
}

function renderAttempt(roots: readonly Folder[], view: View, depthLimit: number | null): { text: string; markers: Set<Marker> } | null {
  const parts: string[] = [], usedMarkers = new Set<Marker>();
  let remaining = treeBudgetUnits;
  for (const [rootIndex, root] of roots.entries()) {
    let bytes = 0;
    const lines: string[] = [];
    const append = (line: string): boolean => {
      lines.push(line + '\n'); bytes += Buffer.byteLength(line) + 1;
      return estimateUnits(bytes) < remaining;
    };
    const leaf = (node: Leaf, prefix: string, last: boolean): boolean => {
      usedMarkers.add(node.marker);
      return append(prefix + (last ? '└── ' : '├── ') + node.name + node.marker);
    };
    const selectedOnly = (node: Node, prefix: string, last: boolean): boolean => {
      if (node.kind === 'file') return leaf(node, prefix, last);
      if (!append(prefix + (last ? '└── ' : '├── ') + node.name)) return false;
      const nestedPrefix = prefix + (last ? '    ' : '│   '), nodes = children(node, 'selected');
      return nodes.every((child, index) => selectedOnly(child, nestedPrefix, index === nodes.length - 1));
    };
    const emit = (folder: Folder, depth: number, prefix: string, last: boolean): boolean => {
      if (!append((depth === 0 ? '' : prefix + (last ? '└── ' : '├── ')) + folder.name)) return false;
      const nestedPrefix = prefix + (depth === 0 ? '' : last ? '    ' : '│   ');
      const visible = children(folder, view);
      if (depthLimit !== null && depth > depthLimit) {
        const selected = visible.filter(isSelected), other = visible.length > selected.length;
        if (!selected.every((node, index) => selectedOnly(node, nestedPrefix, !other && index === selected.length - 1))) return false;
        return !other || append(nestedPrefix + (selected.length ? '├── ' : '└── ') + '...');
      }
      const nodes = prioritized(visible);
      return nodes.every((node, index) => node.kind === 'file'
        ? leaf(node, nestedPrefix, index === nodes.length - 1)
        : emit(node, depth + 1, nestedPrefix, index === nodes.length - 1));
    };
    if (!emit(root, 0, '', true)) return null;
    const text = lines.join('');
    remaining -= Math.max(1, estimateUnits(bytes));
    if (remaining <= 0) return null;
    parts.push(text);
    if (rootIndex < roots.length - 1 && text) parts.push('');
  }
  const text = parts.join('\n');
  return text && estimateUnits(Buffer.byteLength(text)) <= treeBudgetUnits ? { text, markers: usedMarkers } : null;
}
