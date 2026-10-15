import type { RootIdentity } from '../contracts/workspace.js';
import { canonicalJSON, sha256 } from './values.js';

/** Stable headless UUIDs preserve the source graph's identity and ordering rules. */
export function structureId(identity: RootIdentity, path: string | null): string {
  const hex = sha256(canonicalJSON({ identity, path })).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
