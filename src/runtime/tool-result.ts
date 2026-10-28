import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { StructureToolResult } from '../contracts/structure.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { NativeFailure, NativeWorkerFailure } from '../native/bridge-client.js';
import type { CacheRecoveryTarget } from '../contracts/errors.js';
import { SourcePath } from '../contracts/inventory.js';
import { SHA256 } from '../contracts/workspace.js';

const recoveryTarget = Compile(Type.Object({ kind: Type.Enum(['artifact', 'reuse']), key: SHA256 }));
const structureKind = Compile(Type.Pick(StructureToolResult, ['kind']));
const structureResult = Compile(StructureToolResult);
const sourcePath = Compile(SourcePath);

/** One text block of compact JSON; a structure result's block is its rendered text, with the data as structuredContent. */
export function toolResult(value: unknown) {
  if (!structureKind.Check(value)) return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false };
  return { content: [{ type: 'text' as const, text: structureResult.Parse(value).text }], structuredContent: value, isError: false };
}

export function piToolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false };
}

export function failureCode(error: unknown): string {
  if (error instanceof WorkspaceFailure || error instanceof NativeFailure || error instanceof NativeWorkerFailure) {
    return error.code;
  }
  return error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'operationFailed';
}

/** The validated recovery target of a cache corruption, conflict or busy failure; null for every other error. */
export function cacheRecoveryTarget(error: unknown): CacheRecoveryTarget | null {
  const code = failureCode(error);
  if (!(error instanceof WorkspaceFailure) || !['cacheCorrupt', 'cacheConflict', 'artifactBusy'].includes(code)) return null;
  const target = error.details.target;
  // A corrupt cache can be an artifact or a workspace's reuse record; the other failures each name one kind.
  const kinds: readonly CacheRecoveryTarget['kind'][] = code === 'cacheCorrupt' ? ['artifact', 'reuse'] : ['artifact'];
  return recoveryTarget.Check(target) && kinds.includes(target.kind) ? { kind: target.kind, key: target.key } : null;
}

export function failureResult(error: unknown) {
  const code = failureCode(error);
  const target = cacheRecoveryTarget(error);
  if (error instanceof WorkspaceFailure && ['limitWithNegativeStart', 'zeroStart', 'gitStatusMalformed', 'gitShowMalformed', 'invalidSelection',
    'gitSnapshotUnavailable', 'gitSnapshotManifestUnavailable', 'gitSnapshotNotFound', 'gitArtifactReadDenied', 'invalidQuestion', 'invalidSearchPattern', 'invalidSearchScope'].includes(code)) {
    return { kind: 'error', code, message: error.details.message };
  }
  if (target) return { kind: 'error', code, target };
  if (error instanceof WorkspaceFailure && ['sourceChanged', 'pipelineChanged'].includes(code) && sourcePath.Check(error.details)) {
    return { kind: 'error', code, source: error.details };
  }
  if (error instanceof WorkspaceFailure && code === 'outputBudgetTooSmall') {
    return { kind: 'outputBudgetTooSmall', requiredBytes: error.details.requiredBytes };
  }
  if (error instanceof WorkspaceFailure && code === 'revisionConflict') {
    return { kind: 'error', code, revision: error.details.revision };
  }
  return { kind: 'error', code };
}
