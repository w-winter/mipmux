import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { StructureToolResult } from '../contracts/structure.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { NativeFailure, NativeWorkerFailure } from '../native/bridge-client.js';
import type { CacheRecoveryTarget } from '../contracts/errors.js';
import { SourcePath } from '../contracts/inventory.js';

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
  if (!(error instanceof WorkspaceFailure) || !['cacheCorrupt', 'cacheConflict', 'artifactBusy', 'membershipCorrupt'].includes(code)) return null;
  const target = error.details.target;
  const kind = code === 'membershipCorrupt' ? 'membership' : 'artifact';
  if (typeof target === 'object' && target !== null && 'kind' in target && 'key' in target && target.kind === kind &&
      typeof target.key === 'string' && /^[a-f0-9]{64}$/.test(target.key)) {
    return { kind, key: target.key };
  }
  return null;
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
