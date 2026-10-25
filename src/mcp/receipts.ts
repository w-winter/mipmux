import { join } from 'node:path';
import type { Manifest, MaterialRecord } from '../contracts/context.js';
import type { JobSnapshot } from '../contracts/jobs.js';
import type { TokenUsage } from '../contracts/discovery.js';
import type { FinalizationResult } from '../context/finalize.js';
import { materialPath, type PreparedPacket } from '../context/packet-prepare.js';
import { estimateUnits } from '../context/budget.js';

/**
 * Describes a published bundle for a model caller: its paths, accounting, one entry per delivered material and its
 * omissions. Bodies, inventory and spans stay in the bundle's manifest.json, which remains the complete record.
 */
export function bundleReceipt(directory: string, manifest: Manifest) {
  return {
    kind: 'ready' as const,
    directory,
    context: { path: join(directory, 'context.md'), ...manifest.files.context },
    accounting: { units: manifest.accounting.units, allowance: manifest.accounting.allowance },
    materials: manifest.materials.map(materialSummary),
    omitted: [
      ...manifest.unavailableRoots.map(root => ({ root: root.root, code: root.code, sources: root.sources.length })),
      ...manifest.unavailableFiles.map(file => ({ path: file.selection.source.root + '/' + file.selection.source.path, code: file.code })),
    ],
  };
}

function materialSummary(record: MaterialRecord) {
  const units = estimateUnits(record.spans.reduce((sum, span) => sum + span.length, 0));
  switch (record.kind) {
    case 'source': {
      const { selection } = record, path = materialPath(record);
      const fields = { path, origin: record.selectionOrigin, required: record.required };
      return selection.kind === 'slices'
        ? { kind: selection.kind, ...fields, lines: record.normalized.map(range => range.start + '-' + range.end).join(','), units }
        : { kind: selection.kind, ...fields, units };
    }
    case 'document': return { kind: 'document' as const, id: record.input.id, role: record.input.role, units };
    case 'patch': return { kind: 'patch' as const, id: record.receipt.input.id, root: record.receipt.input.root, units };
    case 'gitMap': case 'gitPatch': return { kind: record.kind, path: materialPath(record), units };
  }
}

/**
 * A ready job snapshot carries a bundle receipt and the resulting prompt in place of the manifest. Ready and blocked
 * snapshots replace the discovery completions with their count and summed token usage: every completion matched the
 * effective model, or the job would have failed.
 */
export function jobReceipt(snapshot: JobSnapshot) {
  if (!snapshot.localSettled || (snapshot.state !== 'ready' && snapshot.state !== 'blocked')) return snapshot;
  const { completions } = snapshot.discovery;
  const total = (field: keyof TokenUsage) => completions.reduce((sum, completion) => sum + completion.usage[field], 0);
  const discovery = { ...snapshot.discovery, completions: completions.length,
    usage: { input: total('input'), output: total('output'), cacheRead: total('cacheRead'), cacheWrite: total('cacheWrite') } };
  if (snapshot.state === 'blocked') return { ...snapshot, discovery };
  const { bundle, ...rest } = snapshot;
  return { ...rest, discovery, bundle: { ...bundleReceipt(bundle.directory, bundle.manifest), prompt: bundle.manifest.prompt } };
}

/** A ready finalization returns its bundle receipt; a blocked one is returned unchanged. */
export function publicationReceipt(result: FinalizationResult) {
  return result.kind === 'ready' ? bundleReceipt(result.directory, result.manifest) : result;
}

/** A ready preparation lists only the materials it added to or removed from the saved bundle; a blocked one is returned unchanged. */
export function prepareReceipt(result: PreparedPacket) {
  if (result.kind !== 'ready') return result;
  const { materials: _materials, ...receipt } = bundleReceipt(result.directory, result.manifest);
  const key = (record: MaterialRecord) => { const { units: _units, ...entry } = materialSummary(record); return JSON.stringify(entry); };
  const saved = new Set(result.saved.materials.map(key)), current = new Set(result.manifest.materials.map(key));
  return { ...receipt, added: result.manifest.materials.filter(record => !saved.has(key(record))).map(materialSummary),
    removed: result.saved.materials.filter(record => !current.has(key(record))).map(materialSummary) };
}
