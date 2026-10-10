import type { DiscoveryCall, DiscoveryEvent, DiscoveryInput, DiscoveryReceipt } from '../contracts/discovery.js';
import type { ResultEncoding } from '../exploration/output-budget.js';
export type { DiscoveryInput } from '../contracts/discovery.js';
export interface DiscoveryTools {
  /** Measures paged results through the runner's complete serialized tool-result encoding. */
  call(call: DiscoveryCall, signal: AbortSignal, encode: ResultEncoding): Promise<unknown>;
}
export type DiscoveryOutcome =
  | { readonly kind: 'complete'; readonly receipt: DiscoveryReceipt }
  | { readonly kind: 'failed' | 'cancelled'; readonly code: string; readonly receipt: DiscoveryReceipt };

/** Returns only after owned tools, observations and the worker have settled locally. */
export interface DiscoveryRunner {
  run(input: DiscoveryInput, tools: DiscoveryTools, signal: AbortSignal,
    progress: (event: DiscoveryEvent) => void): Promise<DiscoveryOutcome>;
}
