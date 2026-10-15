import { performance } from 'node:perf_hooks';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { observe } from '../workspace/observe.js';
import { acquireSource, type Material } from './material-store.js';
import { failureCode } from '../runtime/tool-result.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';

// RPCE WorkspaceCodemapPresentationCoordinator's production readiness allowance.
const codemapReadinessMilliseconds = 10000;
// RPCE WorkspaceFileContextStore's frozen presentation admission, before rendering.
const maximumCodemapPresentationEntriesPerRoot = 4096;

type PendingPresentation = Extract<Material, { availability: 'pendingCodemap' }>;

function pendingPresentation(material: Material): PendingPresentation | null {
  const record = material.record;
  if (record.kind !== 'source' || record.selectionOrigin !== 'explicit' || record.selection.kind !== 'codemap') return null;
  if (record.artifactKey === null) throw new WorkspaceFailure('invalidArtifact');
  return freeze({ availability: 'pendingCodemap', record: { ...record, selection: record.selection,
    normalized: [], artifactKey: record.artifactKey }, bodies: [], sourceBlock: null });
}

function reportStalePresentation(material: PendingPresentation, cause: string): boolean {
  if (cause !== 'sourceChanged' && cause !== 'policyChanged') return false;
  process.stderr.write(JSON.stringify({ level: 'warn', event: 'codemapPresentationStale',
    ...material.record.selection.source, cause }) + '\n');
  return true;
}

export async function resolveSelectedCodemaps(operation: WorkspaceOperation, materials: ReadonlyMap<string, Material>) {
  const deadline = performance.now() + codemapReadinessMilliseconds;
  const ready = new Map(materials);
  const retains: { readonly material: PendingPresentation;
    readonly lease: Awaited<ReturnType<WorkspaceOperation['requestExplicitCodemap']>> }[] = [];
  const requestsByRoot = new Map<string, PendingPresentation[]>();
  const admitted: PendingPresentation[] = [];
  const work: Promise<void>[] = [];
  const readinessClosed = new AbortController();
  const readinessSignal = AbortSignal.any([operation.signal, readinessClosed.signal]);
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
    timer = setTimeout(() => readinessClosed.abort(), Math.max(0, deadline - performance.now()));
    for (const { material, lease } of retains) {
      work.push((async () => {
        try {
          const entry = await observe(lease.result, readinessSignal);
          if (entry.structural.kind !== 'artifact') throw new WorkspaceFailure('invalidArtifact');
          const outcome = entry.structural.record.outcome.kind;
          if (outcome !== 'ready' && outcome !== 'readyNoSymbols') { admitted.push(material); return; }
          const root = material.record.selection.source.root;
          let requests = requestsByRoot.get(root);
          if (!requests) { requests = []; requestsByRoot.set(root, requests); }
          requests.push(material);
        } catch (error) {
          operation.signal.throwIfAborted();
          const cause = failureCode(error);
          if (cause === 'cancelled' && readinessClosed.signal.aborted) return;
          if (!reportStalePresentation(material, cause)) throw error;
        }
      })());
    }
    await Promise.all(work);
    for (const [root, requests] of requestsByRoot) {
      if (requests.length > maximumCodemapPresentationEntriesPerRoot) {
        process.stderr.write(JSON.stringify({ level: 'warn', event: 'codemapPresentationLimitExceeded', root,
          attempted: requests.length, limit: maximumCodemapPresentationEntriesPerRoot }) + '\n');
        continue;
      }
      admitted.push(...requests);
    }
    for (const material of admitted) work.push((async () => {
      try {
        const complete = await acquireSource(operation, { selectionOrigin: 'explicit', selection: material.record.selection,
          required: material.record.required });
        ready.set(material.record.id, complete);
      } catch (error) {
        operation.signal.throwIfAborted();
        if (!reportStalePresentation(material, failureCode(error))) throw error;
      }
    })());
    await Promise.all(work);
    return new Map(ready);
  } finally {
    readinessClosed.abort();
    if (timer !== null) clearTimeout(timer);
    await Promise.all(retains.map(({ lease }) => lease.release()));
    await Promise.allSettled(work);
  }
}
