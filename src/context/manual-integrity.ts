import type { Manifest, ManualPresentation, SourceSelection } from '../contracts/context.js';
import { manualCopySettings, type CapturedClipboardPreset, type ManualClipboardPreset } from '../contracts/presentation.js';
import type { Material } from './material-store.js';
import { codemapRepresentation, sourceId } from './material-store.js';
import { canonicalJSON, compareBytes, WorkspaceFailure } from '../workspace/values.js';

type ResolvedManualPreset = Extract<CapturedClipboardPreset, { kind: 'manual' }>;
type SourceRecord = Extract<Material['record'], { kind: 'source' }>;

function invalid(): never { throw new WorkspaceFailure('bundleIntegrityFailed'); }

function verifyResolvedSettings(request: ManualClipboardPreset, cfg: ResolvedManualPreset): void {
  const custom = request.customizations;
  const usage = request.codeMapsGloballyDisabled ? 'none' : request.current.codeMapUsage;
  const git = custom.gitInclusion ?? (request.current.gitInclusion === 'all' ? 'complete' : request.current.gitInclusion === 'selectedFiles' ? 'selected' : 'none');
  if (canonicalJSON(cfg) !== canonicalJSON({ kind: 'manual', includeFiles: custom.includeFiles ?? true,
    includeUserPrompt: custom.includeUserPrompt ?? true, includeMetaPrompts: custom.includeMetaPrompts ?? true,
    includeFileTree: custom.includeFileTree ?? true, fileTreeMode: custom.fileTreeMode ?? request.current.fileTreeMode,
    codeMapUsage: usage, gitInclusion: git, storedPromptIds: null })) invalid();
}

function verifyCanonicalSources(manifest: Manifest, proof: ManualPresentation) {
  const catalog = new Map(manifest.inventory.entries.map(entry => [sourceId(entry), entry]));
  const canonical = new Map(proof.canonicalSources.map(selection => [sourceId(selection.source), selection]));
  const direct = new Set(proof.directlySelected.map(sourceId));
  if (canonical.size !== proof.canonicalSources.length || direct.size !== proof.directlySelected.length ||
    proof.canonicalSources.some(source => catalog.get(sourceId(source.source))?.kind !== 'file') ||
    [...direct].some(id => !canonical.has(id) || canonical.get(id)?.kind === 'codemap') ||
    proof.canonicalSources.some(source => source.kind === 'full' && !direct.has(sourceId(source.source)))) invalid();
  return { catalog, canonical, direct };
}

function requestedSources(manifest: Manifest, proof: ManualPresentation, cfg: ResolvedManualPreset) {
  const usage = cfg.codeMapUsage;
  const requested = usage === 'none' ? [] : usage === 'complete'
    ? manifest.inventory.entries.flatMap(entry => entry.kind === 'file' && entry.structural.kind !== 'unsupported' ? [{ root: entry.root, path: entry.path }] : [])
    : proof.canonicalSources.filter(source => usage !== 'auto' || manifest.codemapMode === 'automatic' ? source.kind !== 'codemap' || usage === 'selected' : source.kind === 'codemap').map(source => source.source);
  const roots = new Map(manifest.inventory.roots.map(root => [root.name, root.identity.canonicalPath]));
  requested.sort((a, b) => compareBytes(roots.get(a.root)!, roots.get(b.root)!) || compareBytes(a.path, b.path));
  if (canonicalJSON(requested) !== canonicalJSON(proof.requested) || proof.completeRootSet !== (usage === 'complete')) invalid();
  return requested;
}

function verifyReadySources(manifest: Manifest, proof: ManualPresentation, cfg: ResolvedManualPreset,
  sources: ReturnType<typeof verifyCanonicalSources>, requested: ReturnType<typeof requestedSources>) {
  const catalog = sources.catalog, usage = cfg.codeMapUsage;
  const ready = new Set(proof.ready.map(sourceId));
  const requestedIDs = new Set(requested.map(sourceId));
  if (ready.size !== proof.ready.length || proof.ready.some(source => codemapRepresentation(catalog.get(sourceId(source)), source)?.kind !== 'rendered') ||
    (usage !== 'auto' || manifest.codemapMode !== 'automatic') && proof.ready.some(source => !requestedIDs.has(sourceId(source)))) invalid();
  if ((usage !== 'auto' || manifest.codemapMode !== 'automatic') &&
    canonicalJSON(proof.ready) !== canonicalJSON(requested.filter(source => ready.has(sourceId(source))))) invalid();
  return ready;
}

function verifyDeliveredSource(record: SourceRecord, maps: ReadonlySet<string>, expected: ReadonlyMap<string, SourceSelection>, required: ReadonlySet<string>): void {
  if (maps.has(record.id)) {
    if (record.selection.kind !== 'codemap' || record.selectionOrigin !== (required.has(record.id) ? 'explicit' : 'presentation')) invalid();
  } else if (record.selectionOrigin !== 'explicit' || canonicalJSON(record.selection) !== canonicalJSON(expected.get(record.id))) invalid();
}

function verifyDeliveredMaterials(manifest: Manifest, materials: readonly Material[], proof: ManualPresentation, cfg: ResolvedManualPreset,
  sources: ReturnType<typeof verifyCanonicalSources>, ready: ReadonlySet<string>): void {
  const { canonical, direct } = sources, usage = cfg.codeMapUsage;
  const maps = new Set([...ready].filter(id => usage === 'selected' ? direct.has(id)
    : (usage === 'auto' || usage === 'complete') && canonical.get(id)?.kind !== 'full' && canonical.get(id)?.kind !== 'slices'));
  const orderedMaps = usage === 'selected' ? proof.directlySelected.map(sourceId).filter(id => maps.has(id)) : [...maps];
  const omitted = new Set([...manifest.unavailableRoots.flatMap(root => root.sources), ...manifest.unavailableFiles].map(source => source.id));
  const expected = new Map([...canonical].filter(([id, selection]) => !omitted.has(id) && selection.kind !== 'codemap' && cfg.includeFiles && !maps.has(id)));
  const actual = materials.flatMap(({ record }) => record.kind === 'source' ? [record] : []);
  if (actual.length !== expected.size + maps.size) invalid();
  if (canonicalJSON(actual.filter(record => record.selection.kind === 'codemap').map(record => record.id)) !== canonicalJSON(orderedMaps) ||
    canonicalJSON(actual.filter(record => record.selection.kind !== 'codemap').map(record => record.id)) !== canonicalJSON([...expected.keys()])) invalid();
  const required = new Set(manifest.request.requiredSources.filter(source => source.kind === 'codemap').map(source => sourceId(source.source)));
  for (const record of actual) verifyDeliveredSource(record, maps, expected, required);
  if (!cfg.includeFiles && materials.some(material => material.record.kind === 'document' || material.record.kind === 'gitMap')) invalid();
}

/** Checks captured native decisions and delivered representations using only archived inputs and inventory. */
export function verifyManualPresentation(manifest: Manifest, materials: readonly Material[]): void {
  const request = manualCopySettings(manifest.request.copyPreset), proof = manifest.manualPresentation;
  if (request === null) {
    if (proof !== null || materials.some(material => material.record.kind === 'source' && material.record.selectionOrigin === 'presentation')) invalid();
    return;
  }
  const cfg = manifest.clipboardPreset;
  if (proof === null || cfg.kind !== 'manual') invalid();
  verifyResolvedSettings(request, cfg);
  const sources = verifyCanonicalSources(manifest, proof);
  const requested = requestedSources(manifest, proof, cfg);
  const ready = verifyReadySources(manifest, proof, cfg, sources, requested);
  verifyDeliveredMaterials(manifest, materials, proof, cfg, sources, ready);
}
