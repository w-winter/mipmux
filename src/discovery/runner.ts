import type { DiscoveryCall, DiscoveryEvent, DiscoveryInput, DiscoveryReceipt, DiscoverySelection } from '../contracts/discovery.js';
import type { DiscoverySettings } from './selection.js';
import type { ResultEncoding } from '../exploration/output-budget.js';
export type { DiscoveryInput } from '../contracts/discovery.js';
export interface DiscoveryTools {
  /** Measures paged results through the runner's complete serialized tool-result encoding. */
  call(call: DiscoveryCall, signal: AbortSignal, encode: ResultEncoding): Promise<unknown>;
}
export type DiscoveryOutcome<Receipt extends DiscoveryReceipt = DiscoveryReceipt> =
  | { readonly kind: 'complete'; readonly receipt: Receipt }
  | { readonly kind: 'failed' | 'cancelled'; readonly code: string; readonly receipt: Receipt };

export interface DiscoveryRunner {
  /** The settings a build runs with, from a request's selection; throws modelNotAllowed for a model it may not select. */
  settings(selection: DiscoverySelection | undefined): DiscoverySettings;
  /** Runs one discovery with settings that `settings` returned; returns only after owned tools, observations and the worker have settled locally. */
  run(input: DiscoveryInput, tools: DiscoveryTools, signal: AbortSignal,
    progress: (event: DiscoveryEvent) => void, settings: DiscoverySettings): Promise<DiscoveryOutcome>;
}
