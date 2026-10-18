import { performance } from 'node:perf_hooks';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { CodemapMode } from '../contracts/context.js';
import type { AutomaticAcquisitionState } from '../contracts/automatic-codemaps.js';
import type { DerivedMaterials } from './automatic-codemap-acquisition.js';
import { observe } from '../workspace/observe.js';
import { acquireSource, type Material } from './material-store.js';
import { descriptorGitMode } from '../contracts/patches.js';
import { structureId } from '../workspace/structure-identity.js';
import { failureCode } from '../runtime/tool-result.js';
import { canonicalJSON, compareBytes, freeze, WorkspaceFailure } from '../workspace/values.js';
import { unavailableSelectionRoots } from './source-presentation.js';

// RPCE WorkspaceCodemapPresentationCoordinator's production readiness allowance.
const codemapReadinessMilliseconds = 10000;
const maximumPresentationAttempts = 2;
// RPCE WorkspaceFileContextStore's frozen presentation admission, before rendering.
const maximumCodemapPresentationEntriesPerRoot = 4096;

type PendingPresentation = Extract<Material, { availability: 'pendingCodemap' }>;
type SourceRecord = Extract<Material['record'], { kind: 'source' }>;
type Currentness = 'current' | 'stale';

export interface CodemapPresentation {
  readonly materials: ReadonlyMap<string, Material>;
  readonly automaticAcquisition: AutomaticAcquisitionState;
}

interface CollectedPresentation extends CodemapPresentation {
  readonly automaticAcquisition: Extract<AutomaticAcquisitionState, { kind: 'settled' }>;
}

type AttemptCompletion<T> =
  | { readonly kind: 'current'; readonly presentation: CollectedPresentation; readonly value: T }
  | { readonly kind: 'stale'; readonly presentation: CollectedPresentation };

function pendingPresentation(material: Material): PendingPresentation | null {
  const record = material.record;
  if (record.kind !== 'source' || record.selection.kind !== 'codemap') return null;
  if (record.artifactKey === null) throw new WorkspaceFailure('invalidArtifact');
  return freeze({ availability: 'pendingCodemap', record: { ...record, selection: record.selection,
    normalized: [], artifactKey: record.artifactKey }, bodies: [], sourceBlock: null });
}

function reportStalePresentation(record: SourceRecord, cause: string): boolean {
  if (cause !== 'sourceChanged' && cause !== 'policyChanged') return false;
  process.stderr.write(JSON.stringify({ level: 'warn', event: 'codemapPresentationStale',
    ...record.selection.source, cause }) + '\n');
  return true;
}

async function revalidateSourceRecord(operation: WorkspaceOperation, record: SourceRecord): Promise<void> {
  const current = await operation.readRawSource(record.selection.source);
  if (canonicalJSON([current.identity, descriptorGitMode(current.fingerprint.mode)]) !== canonicalJSON([record.identity, record.mode]) ||
    record.selection.kind === 'codemap' && canonicalJSON(current.key) !== canonicalJSON(record.artifactKey)) {
    throw new WorkspaceFailure('sourceChanged', record.selection.source);
  }
}

async function renderRootCodemaps(operation: WorkspaceOperation, requests: PendingPresentation[]): Promise<{
  readonly currentness: Currentness; readonly materials: readonly Material[];
}> {
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
        await revalidateSourceRecord(operation, material.record);
        process.stderr.write(JSON.stringify({ level: 'warn', event: 'codemapRootPresentationUnavailable',
          ...material.record.selection.source, cause: 'noRenderableCodemap' }) + '\n');
        return { currentness: 'current', materials: [complete] };
      }
      rendered.push(complete);
    }
    for (const material of requests) {
      serving = material;
      await revalidateSourceRecord(operation, material.record);
    }
    return { currentness: 'current', materials: rendered };
  } catch (error) {
    operation.signal.throwIfAborted();
    if (!reportStalePresentation(serving.record, failureCode(error))) throw error;
    return { currentness: 'stale', materials: [] };
  }
}

async function withCodemapAttempt<T>(operation: WorkspaceOperation, materials: ReadonlyMap<string, Material>, deadline: number,
  complete: (materials: ReadonlyMap<string, Material>, currentness: Currentness) => Promise<T>): Promise<T> {
  const ready = new Map(materials);
  let currentness: Currentness = 'current';
  const retains: { readonly material: PendingPresentation;
    readonly lease: Awaited<ReturnType<WorkspaceOperation['requestExplicitCodemap']>> }[] = [];
  const requestsByRoot = new Map<string, PendingPresentation[]>();
  const inferredByRoot = new Map<string, PendingPresentation[]>();
  const presentations: (() => void)[] = [];
  const admitted: PendingPresentation[] = [];
  const work: Promise<void>[] = [];
  const readinessClosed = new AbortController();
  const readinessSignal = AbortSignal.any([operation.signal, readinessClosed.signal]);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const unavailableRoots = await unavailableSelectionRoots(operation, materials);
    for (const captured of materials.values()) {
      const material = pendingPresentation(captured);
      if (material === null) continue;
      if (material.record.selectionOrigin === 'inferred') {
        const root = material.record.selection.source.root;
        let inferred = inferredByRoot.get(root);
        if (!inferred) { inferred = []; inferredByRoot.set(root, inferred); }
        inferred.push(material);
        continue;
      }
      ready.set(material.record.id, material);
      if (unavailableRoots.has(material.record.selection.source.root)) continue;
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
          if (!reportStalePresentation(material.record, cause)) throw error;
          currentness = 'stale';
        }
      })());
    }
    await Promise.all(work);
    for (const root of new Set([...requestsByRoot.keys(), ...inferredByRoot.keys()])) {
      const requests = requestsByRoot.get(root) ?? [], inferred = inferredByRoot.get(root) ?? [];
      if (requests.length > maximumCodemapPresentationEntriesPerRoot) {
        process.stderr.write(JSON.stringify({ level: 'warn', event: 'codemapPresentationLimitExceeded', root,
          attempted: requests.length, limit: maximumCodemapPresentationEntriesPerRoot }) + '\n');
        continue;
      }
      const release = operation.retainCodemapPresentation(root);
      if (release === null) {
        for (const material of inferred) ready.set(material.record.id, material);
        continue;
      }
      presentations.push(release);
      if (!requests.length) continue;
      const rendered = await renderRootCodemaps(operation, requests);
      if (rendered.currentness === 'stale') currentness = 'stale';
      for (const material of rendered.materials) ready.set(material.record.id, material);
    }
    for (const material of admitted) work.push((async () => {
      try {
        const complete = await acquireSource(operation, { selectionOrigin: 'explicit', selection: material.record.selection,
          required: material.record.required });
        ready.set(material.record.id, complete);
      } catch (error) {
        operation.signal.throwIfAborted();
        if (!reportStalePresentation(material.record, failureCode(error))) throw error;
        currentness = 'stale';
      }
    })());
    await Promise.all(work);
    return await complete(new Map(ready), currentness);
  } finally {
    readinessClosed.abort();
    if (timer !== null) clearTimeout(timer);
    for (const release of presentations) release();
    await Promise.all(retains.map(({ lease }) => lease.release()));
    await Promise.allSettled(work);
  }
}

function incompletePublication(mode: CodemapMode, presentation: CollectedPresentation): CodemapPresentation {
  const materials = new Map<string, Material>();
  for (const [id, material] of presentation.materials) {
    if (material.record.kind !== 'source' || material.record.selection.kind !== 'codemap') materials.set(id, material);
    else {
      const pending = pendingPresentation(material);
      if (pending?.record.selectionOrigin === 'explicit') materials.set(id, pending);
    }
  }
  return { materials, automaticAcquisition: mode === 'automatic'
    ? { kind: 'pending', candidateCount: presentation.automaticAcquisition.outcomes.length }
    : presentation.automaticAcquisition };
}

async function publicationCurrentness(operation: WorkspaceOperation, mode: CodemapMode,
  presentation: CodemapPresentation): Promise<Currentness> {
  const roots = new Map<string, boolean>();
  for (const material of presentation.materials.values()) {
    const record = material.record;
    if (record.kind !== 'source') continue;
    if (record.selection.kind === 'codemap' && (material.availability !== 'settled' || !material.bodies.length)) continue;
    if (record.selection.kind !== 'codemap' && mode !== 'automatic') continue;
    const root = record.selection.source.root;
    if (!roots.has(root)) roots.set(root, (await operation.sourceRootAvailability(root)).kind === 'available');
    if (!roots.get(root)) continue;
    try { await revalidateSourceRecord(operation, record); }
    catch (error) {
      operation.signal.throwIfAborted();
      if (!reportStalePresentation(record, failureCode(error))) throw error;
      return 'stale';
    }
  }
  return 'current';
}

/** Shares a performance.now() start across two attempts; assembly and serving checks retain demand until release. Errors and cancellation propagate. */
export async function withCodemapPresentation<T>(operation: WorkspaceOperation, mode: CodemapMode, startedAtMilliseconds: number,
  prepare: () => Promise<DerivedMaterials>, render: (presentation: CodemapPresentation) => Promise<T>): Promise<T> {
  const deadline = startedAtMilliseconds + codemapReadinessMilliseconds;
  for (let attempt = 1; ; attempt++) {
    operation.signal.throwIfAborted();
    const derived = await prepare();
    const completion = await withCodemapAttempt(operation, derived.materials, deadline, async (materials, currentness): Promise<AttemptCompletion<T>> => {
      const presentation: CollectedPresentation = { materials, automaticAcquisition: { kind: 'settled', outcomes: derived.automaticCodemaps } };
      const staleAcquisition = derived.automaticCodemaps.some(item => item.outcome.kind === 'unavailable' &&
        (item.outcome.cause === 'sourceChanged' || item.outcome.cause === 'policyChanged'));
      if (currentness === 'stale' || staleAcquisition) return { kind: 'stale', presentation };
      const value = await render(presentation);
      operation.signal.throwIfAborted();
      if (await publicationCurrentness(operation, mode, presentation) === 'stale') return { kind: 'stale', presentation };
      return { kind: 'current', presentation, value };
    });
    if (completion.kind === 'current') return completion.value;
    if (attempt < maximumPresentationAttempts && performance.now() < deadline) continue;
    const value = await render(incompletePublication(mode, completion.presentation));
    operation.signal.throwIfAborted();
    return value;
  }
}
