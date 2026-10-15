import { join } from 'node:path';
import { type Manifest, type MaterialRecord, manifestValidator } from '../contracts/context.js';
import type { InventoryEntry } from '../contracts/inventory.js';
import type { SmipRuntime } from '../runtime/smip-runtime.js';
import { canonicalJSON, sha256, WorkspaceFailure } from '../workspace/values.js';
import { inventoryDigest } from '../workspace/artifact-store.js';
import { codemapRepresentation, identity, type Material, normalizeRanges, sourceId } from './material-store.js';
import { renderBundle } from './render.js';
import { readRegularFile } from '../runtime/host-files.js';
import { StructureIndex } from '../workspace/structure-index.js';
import { parseSourceBlock, type SourceBlock } from './source-block.js';
import { finalFileTreeInput } from './final-tree.js';

function requireEqual(a: unknown, b: unknown): void {
  if (canonicalJSON(a) !== canonicalJSON(b)) throw new WorkspaceFailure('bundleIntegrityFailed');
}

/** Verifies saved files, representation bodies and accounting using only bundle bytes. */
export async function verifyBundle(directory: string) {
  return (await loadVerifiedBundle(directory)).verified;
}

export async function loadVerifiedBundle(directory: string, signal?: AbortSignal) {
  const raw = await readBundleFile(directory, 'manifest.json', signal);
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
    throw new WorkspaceFailure('invalidManifest');
  }
  if (!manifestValidator.Check(manifest)) throw new WorkspaceFailure('invalidManifest');
  requireEqual(manifest.deniedAbsolutePaths.includes(manifest.inventory.outputRoot.canonicalPath), true);
  const inventoryPaths = new Set<string>();
  for (const entry of manifest.inventory.entries) {
    const id = sourceId(entry);
    if (inventoryPaths.has(id)) throw new WorkspaceFailure('bundleIntegrityFailed');
    inventoryPaths.add(id);
  }
  requireEqual(manifest.decoder, manifest.inventory.decoderPolicy);
  const context = await readBundleFile(directory, 'context.md', signal),
    handoff = await readBundleFile(directory, 'handoff.md', signal);
  requireEqual(identity(context), manifest.files.context);
  requireEqual(identity(handoff), manifest.files.handoff);
  requireEqual(sha256(canonicalJSON(manifest.request)), manifest.requestDigest);
  requireEqual(inventoryDigest(manifest.inventory), manifest.inventory.inventoryDigest);
  const materials = decodeMaterials(manifest, context);
  requireEqual(manifest.fileTree.input, finalFileTreeInput(manifest.inventory, materials, manifest.codemapMode));
  const treeSpan = manifest.fileTree.span, treeBytes = context.subarray(treeSpan.offset, treeSpan.offset + treeSpan.length);
  requireEqual(identity(treeBytes), { byteCount: treeSpan.length, sha256: treeSpan.sha256 });
  const fileTree = { input: manifest.fileTree.input, text: decodedBody(treeBytes) };
  const automaticSpan = manifest.automaticGit?.span;
  const automaticText = automaticSpan ? context.subarray(automaticSpan.offset, automaticSpan.offset + automaticSpan.length) : null;
  if (automaticText && automaticSpan) requireEqual(identity(automaticText), { byteCount: automaticSpan.length, sha256: automaticSpan.sha256 });
  const automaticGit = manifest.automaticGit === null ? null : { evidence: manifest.automaticGit.evidence,
    text: automaticText === null ? null : decodedBody(automaticText) };
  let rendered: ReturnType<typeof renderBundle>;
  try { rendered = renderBundle({
    codemapMode: manifest.codemapMode,
    request: manifest.request,
    inventory: manifest.inventory,
    prompt: manifest.prompt,
    materials,
    automaticAcquisition: { kind: 'settled', outcomes: manifest.automaticCodemaps },
    fileTree,
    clipboard: decodedBody(context),
    clipboardPreset: manifest.clipboardPreset,
    selectedGitDiffIds: materials.filter(material => material.record.kind === 'gitPatch').map(material => material.record.id),
    automaticGit,
  }); } catch (error) {
    if (!(error instanceof WorkspaceFailure && error.code === 'invalidClipboard')) throw error;
    throw new WorkspaceFailure('bundleIntegrityFailed');
  }
  if (
    rendered.diagnostics.length || !Buffer.from(rendered.context).equals(context) ||
    !Buffer.from(rendered.handoff).equals(handoff)
  ) throw new WorkspaceFailure('bundleIntegrityFailed');
  requireEqual(rendered.records, manifest.materials);
  requireEqual(rendered.fileTreeSpan, manifest.fileTree.span);
  requireEqual(rendered.automaticGitSpan, manifest.automaticGit?.span ?? null);
  requireEqual({
    bytes: rendered.measurement.bytes,
    units: rendered.measurement.units,
    allowance: rendered.measurement.allowance,
  }, { bytes: manifest.accounting.bytes, units: manifest.accounting.units, allowance: manifest.accounting.allowance });
  return { verified: { kind: 'verified' as const, manifest }, materials, fileTree, automaticGit, clipboard: decodedBody(context),
    comparisonText: rendered.comparisonText };
}
function readBundleFile(directory: string, filename: string, signal: AbortSignal | undefined): Promise<Buffer> {
  return readRegularFile(join(directory, filename), new WorkspaceFailure('nonRegularBundleFile', { component: filename }), signal);
}
function decodedBody(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new WorkspaceFailure('bundleIntegrityFailed');
  }
}
function verifyCodemap(record: Extract<MaterialRecord, { kind: 'source' }>, entry: InventoryEntry, bodies: readonly string[]): void {
  requireEqual(record.frame, null);
  const representation = codemapRepresentation(entry, record.selection.source);
  if (!representation) throw new WorkspaceFailure('bundleIntegrityFailed');
  requireEqual(record.artifactKey, representation.key);
  if (representation.kind === 'unmapped') requireEqual(record.selectionOrigin, 'explicit');
  requireEqual(bodies, representation.kind === 'rendered' ? [representation.body] : []);
}
function verifySourceMaterial(record: Extract<MaterialRecord, { kind: 'source' }>, entry: InventoryEntry | undefined, bodies: readonly string[]): void {
  requireEqual(record.id, sourceId(record.selection.source));
  if (entry?.kind !== 'file') throw new WorkspaceFailure('bundleIntegrityFailed');
  requireEqual(entry.identity, record.identity);
  requireEqual(entry.decoding, record.decoding);
  if (record.decoding.kind === 'decoded') {
    if (record.selection.kind === 'full') {
      requireEqual(bodies.length, 1);
      requireEqual(identity(bodies[0]!), record.decoding.identity);
    }
    if (record.selection.kind === 'slices') {
      requireEqual(record.normalized, normalizeRanges(record.selection.ranges, Number.MAX_SAFE_INTEGER));
      requireEqual(bodies.length, record.normalized.length);
    }
  } else {
    requireEqual(bodies, []);
  }
  if (record.selection.kind === 'codemap') verifyCodemap(record, entry, bodies);
}
function decodeMaterials(manifest: Manifest, context: Buffer): Extract<Material, { availability: 'settled' }>[] {
  const seen = new Set<string>();
  const materials = manifest.materials.map((record) => {
    if (seen.has(record.id)) throw new WorkspaceFailure('bundleIntegrityFailed');
    seen.add(record.id);
    const bodies = record.spans.map((span) => {
      const body = context.subarray(span.offset, span.offset + span.length);
      return decodedBody(body);
    });
    let sourceBlock: SourceBlock | null = null;
    if (record.kind === 'source') {
      const entry = manifest.inventory.entries.find((entry) =>
        entry.root === record.selection.source.root && entry.path === record.selection.source.path
      );
      verifySourceMaterial(record, entry, bodies);
      if (record.selection.kind !== 'codemap') {
        const frame = record.frame;
        if (!frame) throw new WorkspaceFailure('bundleIntegrityFailed');
        const bytes = context.subarray(frame.offset, frame.offset + frame.length);
        requireEqual(identity(bytes), { byteCount: frame.length, sha256: frame.sha256 });
        sourceBlock = parseSourceBlock(record, { text: decodedBody(bytes),
          bodySpans: record.spans.map(span => ({ offset: span.offset - frame.offset, length: span.length })) },
          bodies, new WorkspaceFailure('bundleIntegrityFailed'));
      }
    } else if (record.kind === 'document') {
      requireEqual(record.id, 'document:' + record.input.id);
      requireEqual(bodies.length, 1);
      requireEqual(identity(bodies[0]!), record.identity);
      if ('sourceIdentity' in record) {
        const entry = manifest.inventory.entries.find(entry =>
          entry.root === record.input.source.root && entry.path === record.input.source.path
        );
        if (entry?.kind !== 'file' || entry.decoding.kind !== 'decoded') throw new WorkspaceFailure('bundleIntegrityFailed');
        requireEqual(entry.identity, record.sourceIdentity);
        requireEqual(entry.decoding.identity, record.identity);
      } else requireEqual(bodies[0], record.input.text);
      const frame = record.frame;
      if (!frame) throw new WorkspaceFailure('bundleIntegrityFailed');
      const bytes = context.subarray(frame.offset, frame.offset + frame.length);
      requireEqual(identity(bytes), { byteCount: frame.length, sha256: frame.sha256 });
      sourceBlock = parseSourceBlock(record, { text: decodedBody(bytes),
        bodySpans: record.spans.map(span => ({ offset: span.offset - frame.offset, length: span.length })) },
        bodies, new WorkspaceFailure('bundleIntegrityFailed'));
    } else if (record.kind === 'gitMap' || record.kind === 'gitPatch') {
      requireEqual(record.id, 'gitArtifact:' + record.reference.alias);
      requireEqual(record.reference.alias, '_git_data/' + record.reference.snapshotDir + '/' + record.reference.path);
      requireEqual(record.reference.snapshotDir, 'repos/' + record.reference.checkout.repoKey + '/' + record.reference.snapshotID);
      requireEqual(record.reference.absolutePath.endsWith('/' + record.reference.alias), true);
      requireEqual(bodies.length, 1); requireEqual(identity(bodies[0]!), record.identity);
      if (record.kind === 'gitMap') {
        requireEqual(record.reference.path, 'MAP.txt');
        const frame = record.frame;
        if (!frame) throw new WorkspaceFailure('bundleIntegrityFailed');
        const bytes = context.subarray(frame.offset, frame.offset + frame.length);
        requireEqual(identity(bytes), { byteCount: frame.length, sha256: frame.sha256 });
        sourceBlock = parseSourceBlock(record, { text: decodedBody(bytes),
          bodySpans: record.spans.map(span => ({ offset: span.offset - frame.offset, length: span.length })) },
          bodies, new WorkspaceFailure('bundleIntegrityFailed'));
      } else if (!record.reference.path.startsWith('diff/') || !/\.(patch|diff)$/iu.test(record.reference.path)) {
        throw new WorkspaceFailure('bundleIntegrityFailed');
      }
    } else {
      requireEqual(record.id, 'patch:' + record.receipt.input.id);
      requireEqual(bodies.length, 1);
      requireEqual(identity(bodies[0]!), record.receipt.identity);
      if (record.receipt.input.kind === 'suppliedPatch') {
        requireEqual(bodies[0], record.receipt.input.text);
        requireEqual(record.receipt.targets, record.receipt.input.targets);
        requireEqual(record.receipt.coverage, record.receipt.input.coverage);
        requireEqual(record.receipt.repository, null);
        const paths = [...new Set([...record.receipt.input.coverage, ...record.receipt.input.targets.map(target => target.path)])].sort();
        requireEqual(record.receipt.policies.map(control => control.path).sort(), paths);
      }
    }
    return { availability: 'settled' as const, record: { ...record, spans: [] }, bodies, sourceBlock };
  });
  for (const selection of manifest.request.requiredSources) {
    const material = materials.find((material) => material.record.id === sourceId(selection.source));
    if (material?.record.kind !== 'source' || material.record.selectionOrigin !== 'explicit' || !material.record.required) {
      throw new WorkspaceFailure('bundleIntegrityFailed');
    }
    requireEqual(material.record.selection, selection);
  }
  for (const input of manifest.request.documents) {
    const material = materials.find((material) => material.record.id === 'document:' + input.id);
    if (material?.record.kind !== 'document') throw new WorkspaceFailure('bundleIntegrityFailed');
    requireEqual(material.record.input, input);
  }
  for (const input of manifest.request.patches) {
    const material = materials.find((material) => material.record.id === 'patch:' + input.id);
    if (material?.record.kind !== 'patch') throw new WorkspaceFailure('bundleIntegrityFailed');
    requireEqual(material.record.receipt.input, input);
  }
  const sources = materials.flatMap(material => material.record.kind === 'source' ? [material.record] : []);
  const explicit = sources.filter(record => record.selectionOrigin === 'explicit');
  const inferred = sources.filter(record => record.selectionOrigin === 'inferred').map(record => record.id).sort();
  if (manifest.codemapMode === 'manual') {
    requireEqual(inferred, []); requireEqual(manifest.automaticCodemaps, []);
  }
  else {
    if (explicit.some(record => record.selection.kind === 'codemap')) throw new WorkspaceFailure('bundleIntegrityFailed');
    const seeds = explicit.map(record => record.selection.source);
    const candidates = seeds.length ? new StructureIndex(manifest.inventory).resolveAutomaticCodemapTargets(seeds).targets : [];
    const byId = new Map(candidates.map(candidate => [sourceId(candidate), candidate]));
    requireEqual(manifest.automaticCodemaps.map(item => sourceId(item.source)).sort(), [...byId.keys()].sort());
    for (const outcome of manifest.automaticCodemaps) {
      const candidate = byId.get(sourceId(outcome.source));
      if (candidate?.structural.kind !== 'artifact') throw new WorkspaceFailure('bundleIntegrityFailed');
      requireEqual(outcome.identity, candidate.identity); requireEqual(outcome.artifactKey, candidate.structural.key);
    }
    const expected = manifest.automaticCodemaps.filter(item => item.outcome.kind === 'ready').map(item => sourceId(item.source)).sort();
    requireEqual(inferred, expected);
  }
  return materials;
}

/** Adds current root, delivered-source, policy and comparison checks without editing saved files. */
export async function verifyCurrentBundle(directory: string, runtime: SmipRuntime, signal: AbortSignal) {
  return runtime.verifyCurrentBundle(directory, signal);
}
