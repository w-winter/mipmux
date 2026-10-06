import type { InventorySnapshot } from '../contracts/inventory.js';
import type { Continuation } from '../contracts/exploration.js';
import { canonicalJSON, sha256, WorkspaceFailure } from '../workspace/values.js';

export function pageIdentity(snapshot: InventorySnapshot, request: unknown, sources: unknown): string {
  return sha256(canonicalJSON({ inventory: snapshot.inventoryDigest, generation: snapshot.generation,
    policy: snapshot.policy.digest, request, sources }));
}
export function pageOffset(continuation: Continuation | null, digest: string): number {
  if (continuation && continuation.digest !== digest) throw new WorkspaceFailure('staleContinuation');
  return continuation?.offset ?? 0;
}
