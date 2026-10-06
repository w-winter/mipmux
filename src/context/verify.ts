import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { type Manifest, manifestValidator } from '../contracts/context.js';
import type { SmipRuntime } from '../runtime/smip-runtime.js';
import { canonicalJSON, sha256, WorkspaceFailure } from '../workspace/values.js';
import { inventoryDigest } from '../workspace/artifact-store.js';
import { codemapRepresentation, identity, type Material, normalizeRanges, sourceId } from './material-store.js';
import { renderBundle } from './render.js';

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
  } catch {
    throw new WorkspaceFailure('invalidManifest');
  }
  if (!manifestValidator.Check(manifest)) throw new WorkspaceFailure('invalidManifest');
  const context = await readBundleFile(directory, 'context.md', signal),
    handoff = await readBundleFile(directory, 'handoff.md', signal);
  requireEqual(identity(context), manifest.files.context);
  requireEqual(identity(handoff), manifest.files.handoff);
  requireEqual(sha256(canonicalJSON(manifest.request)), manifest.requestDigest);
  requireEqual(inventoryDigest(manifest.inventory), manifest.inventory.inventoryDigest);
  const materials = decodeMaterials(manifest, context);
  const rendered = renderBundle({
    request: manifest.request,
    inventory: manifest.inventory,
    handoff: manifest.handoff,
    materials,
  });
  if (
    rendered.diagnostics.length || !Buffer.from(rendered.context).equals(context) ||
    !Buffer.from(rendered.handoff).equals(handoff)
  ) throw new WorkspaceFailure('bundleIntegrityFailed');
  requireEqual(rendered.records, manifest.materials);
  requireEqual({
    bytes: rendered.measurement.bytes,
    units: rendered.measurement.units,
    allowance: rendered.measurement.allowance,
  }, { bytes: manifest.accounting.bytes, units: manifest.accounting.units, allowance: manifest.accounting.allowance });
  return { verified: { kind: 'verified' as const, manifest }, materials };
}
async function readBundleFile(directory: string, filename: string, signal: AbortSignal | undefined): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal?.throwIfAborted();
    if (!(await file.stat()).isFile()) throw new WorkspaceFailure('nonRegularBundleFile', { component: filename });
    signal?.throwIfAborted();
    const bytes = await file.readFile(signal ? { signal } : {});
    signal?.throwIfAborted();
    return bytes;
  } finally { await file.close(); }
}
function decodeMaterials(manifest: Manifest, context: Buffer): Material[] {
  const seen = new Set<string>();
  const materials = manifest.materials.map((record) => {
    if (seen.has(record.id)) throw new WorkspaceFailure('bundleIntegrityFailed');
    seen.add(record.id);
    const bodies = record.spans.map((span) => {
      const body = context.subarray(span.offset, span.offset + span.length);
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
      } catch {
        throw new WorkspaceFailure('bundleIntegrityFailed');
      }
    });
    if (record.kind === 'source') {
      requireEqual(record.id, sourceId(record.selection.source));
      const entry = manifest.inventory.entries.find((entry) =>
        entry.root === record.selection.source.root && entry.path === record.selection.source.path
      );
      if (entry?.kind !== 'file') throw new WorkspaceFailure('bundleIntegrityFailed');
      requireEqual(entry.identity, record.identity);
      if (record.selection.kind === 'full') {
        requireEqual(bodies.length, 1);
        requireEqual(identity(bodies[0]!), record.identity);
      }
      if (record.selection.kind === 'slices') {
        requireEqual(record.normalized, normalizeRanges(record.selection.ranges, Number.MAX_SAFE_INTEGER));
        requireEqual(bodies.length, record.normalized.length);
      }
      if (record.selection.kind === 'codemap') {
        const representation = codemapRepresentation(entry, record.selection.source);
        if (!representation) throw new WorkspaceFailure('bundleIntegrityFailed');
        requireEqual(record.artifactKey, representation.key);
        requireEqual(bodies, [representation.body]);
      }
    } else if (record.kind === 'document') {
      requireEqual(record.id, 'document:' + record.input.id);
      requireEqual(bodies.length, 1);
      requireEqual(identity(bodies[0]!), record.identity);
      if (record.input.kind === 'suppliedDocument') requireEqual(bodies[0], record.input.text);
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
    return { record: { ...record, spans: [] }, bodies };
  });
  for (const selection of manifest.request.requiredSources) {
    const material = materials.find((material) => material.record.id === sourceId(selection.source));
    if (material?.record.kind !== 'source' || !material.record.required) {
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
  return materials;
}

/** Adds current root, delivered-source, policy and comparison checks without editing saved files. */
export async function verifyCurrentBundle(directory: string, runtime: SmipRuntime, signal: AbortSignal) {
  return runtime.verifyCurrentBundle(directory, signal);
}
