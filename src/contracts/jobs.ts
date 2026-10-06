import type { DiscoveryReceipt, DiscoveryEvent } from './discovery.js';
import type { CacheRecoveryTarget } from './errors.js';
import type { FinalizationResult } from '../context/finalize.js';

export type JobPhase = 'accepted' | 'reconciling' | 'acquiringMaterials' | 'discovering' |
  'settlingDiscovery' | 'finalizing' | 'publishing' | 'cancelling';
export type JobTerminal =
  | { readonly state: 'ready'; readonly bundle: Extract<FinalizationResult, { kind: 'ready' }>; readonly discovery: DiscoveryReceipt }
  | { readonly state: 'blocked'; readonly validation: Extract<FinalizationResult, { kind: 'blocked' }>;
      readonly draftId: string; readonly discovery: DiscoveryReceipt }
  | { readonly state: 'failed' | 'cancelled'; readonly code: string; readonly target: CacheRecoveryTarget | null;
      readonly discovery: DiscoveryReceipt | null };
export type JobSnapshot = { readonly jobId: string; readonly sequence: number; readonly requestDigest: string;
  readonly progress: DiscoveryEvent | null } &
  ((JobTerminal & { readonly localSettled: true; readonly sharedIndexInterest: 'released' }) |
    { readonly state: JobPhase; readonly localSettled: false; readonly sharedIndexInterest: 'retained' });
