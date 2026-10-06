import type { Allowance } from '../contracts/context.js';
import { WorkspaceFailure } from '../workspace/values.js';

export function estimateUnits(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new WorkspaceFailure('invalidByteCount');
  return Number(21n * BigInt(bytes) / 80n);
}
export function resolveAllowance(allowance: Allowance | null): number | null {
  if (allowance === null) return null;
  if (allowance.kind === 'net') return allowance.units;
  const net = BigInt(allowance.settings.contextWindow) -
    Object.values(allowance.reserves).reduce((sum, value) => sum + BigInt(value), 0n);
  if (net < 0) throw new WorkspaceFailure('invalidAllowance');
  return Number(net);
}
