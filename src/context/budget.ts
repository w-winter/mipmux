import { WorkspaceFailure } from '../workspace/values.js';

export function estimateUnits(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new WorkspaceFailure('invalidByteCount');
  return Number(21n * BigInt(bytes) / 80n);
}
// RPCE ContextBuilderAgentViewModel.buildAgentMessage reserves this amount once.
const discoveryReserveUnits = 1500;

export function scoutTokenBudget(budgetUnits: number): number {
  return Math.max(0, budgetUnits - discoveryReserveUnits);
}
