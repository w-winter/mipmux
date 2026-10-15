import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { StructureFile } from '../workspace/structure-index.js';
import { type AutomaticCodemapOutcome, automaticCodemapFailure } from '../contracts/automatic-codemaps.js';
import { failureCode } from '../runtime/tool-result.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';
import { acquireSource, sourceId, type Material } from './material-store.js';

export interface DerivedMaterials {
  readonly materials: ReadonlyMap<string, Material>;
  readonly automaticCodemaps: readonly AutomaticCodemapOutcome[];
}

/** Retains ready targets and captured expected I/O failures; cancellation and invariant failures propagate. */
export async function acquireAutomaticCodemaps(operation: WorkspaceOperation, explicit: Map<string, Material>,
  targets: readonly StructureFile[], context: { readonly draftId: string; readonly revision: number }): Promise<DerivedMaterials> {
  const outcomes: AutomaticCodemapOutcome[] = [];
  for (const target of targets) {
    if (target.structural.kind !== 'artifact') throw new WorkspaceFailure('invalidArtifact');
    const source = { root: target.root, path: target.path };
    const captured = { source, identity: target.identity, artifactKey: target.structural.key };
    try {
      const material = await acquireSource(operation, { selectionOrigin: 'inferred', source });
      operation.signal.throwIfAborted();
      explicit.set(sourceId(source), material);
      outcomes.push({ ...captured, outcome: { kind: 'ready' } });
    } catch (error) {
      operation.signal.throwIfAborted();
      const cause = failureCode(error), expected = automaticCodemapFailure.Check(cause);
      if (cause !== 'cancelled') process.stderr.write(JSON.stringify({ level: expected ? 'warn' : 'error',
        event: 'automaticCodemapAcquisitionFailed', ...context, inventoryDigest: operation.snapshot.inventoryDigest,
        ...source, cause }) + '\n');
      if (!expected) throw error;
      outcomes.push({ ...captured, outcome: { kind: 'unavailable', cause } });
    }
  }
  return { materials: explicit, automaticCodemaps: freeze(outcomes) };
}

export function automaticAcquisitionSummary(outcomes: readonly AutomaticCodemapOutcome[]) {
  const unavailable = outcomes.filter(item => item.outcome.kind === 'unavailable').length;
  const readyCount = outcomes.length - unavailable;
  const status = unavailable === 0 ? 'ok' as const : readyCount === 0 ? 'unavailable' as const : 'partial' as const;
  return { status, readyCount, unavailableCount: unavailable };
}

export function automaticCodemapDisposition(item: AutomaticCodemapOutcome): 'pending' | 'unmapped' | null {
  if (item.outcome.kind === 'ready') return null;
  switch (item.outcome.cause) {
    case 'sourceChanged': case 'policyChanged': case 'permissionDenied': case 'nativeIOFailed':
      return 'pending';
    case 'pathDenied': case 'decodeFailed': case 'binarySource': case 'notFound': case 'nonRegularFile': case 'symlink':
      return 'unmapped';
  }
}
