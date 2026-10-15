import { performance } from 'node:perf_hooks';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { observe } from '../workspace/observe.js';
import { acquireSource, type Material } from './material-store.js';
import { failureCode } from '../runtime/tool-result.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';

// RPCE WorkspaceCodemapPresentationCoordinator's production readiness allowance.
const codemapReadinessMilliseconds = 10000;

function pendingPresentation(material: Material): Extract<Material, { availability: 'pendingCodemap' }> | null {
  const record = material.record;
  if (record.kind !== 'source' || record.selectionOrigin !== 'explicit' || record.required || record.selection.kind !== 'codemap') return null;
  if (record.artifactKey === null) throw new WorkspaceFailure('invalidArtifact');
  return freeze({ availability: 'pendingCodemap', record: { ...record, required: false, selection: record.selection,
    normalized: [], artifactKey: record.artifactKey }, bodies: [], sourceBlock: null });
}

export async function resolveSelectedCodemaps(operation: WorkspaceOperation, materials: ReadonlyMap<string, Material>) {
  const deadline = performance.now() + codemapReadinessMilliseconds;
  const ready = new Map(materials);
  const retains: { readonly material: Extract<Material, { availability: 'pendingCodemap' }>;
    readonly lease: Awaited<ReturnType<WorkspaceOperation['requestExplicitCodemap']>> }[] = [];
  const work: Promise<void>[] = [];
  const expired = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    for (const captured of materials.values()) {
      const material = pendingPresentation(captured);
      if (material === null) continue;
      ready.set(material.record.id, material);
      const lease = await operation.requestExplicitCodemap(material.record.selection.source);
      retains.push({ material, lease });
    }
    operation.signal.throwIfAborted();
    for (const { material, lease } of retains) {
      work.push((async () => {
        try {
          await lease.result;
          const complete = await acquireSource(operation, { selectionOrigin: 'explicit', selection: material.record.selection, required: false });
          ready.set(material.record.id, complete);
        } catch (error) {
          operation.signal.throwIfAborted();
          const cause = failureCode(error);
          if (cause !== 'sourceChanged' && cause !== 'policyChanged') throw error;
          process.stderr.write(JSON.stringify({ level: 'warn', event: 'codemapPresentationStale',
            ...material.record.selection.source, cause }) + '\n');
        }
      })());
    }
    timer = setTimeout(() => expired.abort(), Math.max(0, deadline - performance.now()));
    try { await observe(Promise.all(work), AbortSignal.any([operation.signal, expired.signal])); }
    catch (error) {
      operation.signal.throwIfAborted();
      if (!expired.signal.aborted) throw error;
    }
    return new Map(ready);
  } finally {
    if (timer !== null) clearTimeout(timer);
    await Promise.all(retains.map(({ lease }) => lease.release()));
    await Promise.allSettled(work);
  }
}
