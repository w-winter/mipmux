import { performance } from 'node:perf_hooks';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { observe } from '../workspace/observe.js';
import { acquireSource, type Material } from './material-store.js';
import { descriptorGitMode } from '../contracts/patches.js';
import { structureId } from '../workspace/structure-identity.js';
import { failureCode } from '../runtime/tool-result.js';
import { canonicalJSON, compareBytes, freeze, WorkspaceFailure } from '../workspace/values.js';

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

async function revalidateCodemapSource(operation: WorkspaceOperation, material: PendingPresentation): Promise<void> {
  const current = await operation.readRawSource(material.record.selection.source);
  if (canonicalJSON([current.identity, current.key, descriptorGitMode(current.fingerprint.mode)]) !==
    canonicalJSON([material.record.identity, material.record.artifactKey, material.record.mode])) {
    throw new WorkspaceFailure('sourceChanged', material.record.selection.source);
  }
}

async function renderRootCodemaps(operation: WorkspaceOperation, requests: PendingPresentation[]): Promise<readonly Material[]> {
  let serving = requests[0]!;
  const root = operation.snapshot.roots.find(root => root.name === serving.record.selection.source.root)!;
  requests.sort((left, right) => {
    const leftPath = left.record.selection.source.path, rightPath = right.record.selection.source.path;
    // Swift String ordering treats canonically equivalent paths equally before the file-ID tie-break.
    return compareBytes(leftPath.normalize('NFC'), rightPath.normalize('NFC')) ||
      compareBytes(structureId(root.identity, leftPath), structureId(root.identity, rightPath));
  });
  const rendered: Material[] = [];
  try {
    for (const material of requests) {
      serving = material;
      const complete = await acquireSource(operation, { selectionOrigin: 'explicit', selection: material.record.selection,
        required: material.record.required });
      if (!complete.bodies.length) {
        await revalidateCodemapSource(operation, material);
        process.stderr.write(JSON.stringify({ level: 'warn', event: 'codemapRootPresentationUnavailable',
          ...material.record.selection.source, cause: 'noRenderableCodemap' }) + '\n');
        return [complete];
      }
      rendered.push(complete);
    }
    for (const material of requests) {
      serving = material;
      await revalidateCodemapSource(operation, material);
    }
    return rendered;
  } catch (error) {
    operation.signal.throwIfAborted();
    if (!reportStalePresentation(serving, failureCode(error))) throw error;
    return [];
  }
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
      const rendered = await renderRootCodemaps(operation, requests);
      for (const material of rendered) ready.set(material.record.id, material);
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
