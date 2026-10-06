import { WorkspaceFailure } from '../workspace/values.js';

export function serializedBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
export type ResultEncoding = (value: unknown) => unknown;
export const identityEncoding: ResultEncoding = value => value;
export type BudgetDiagnostic = { readonly kind: 'recordTooLarge'; readonly requiredBytes: number; readonly remedy: string } |
  { readonly kind: 'outputBudgetTooSmall'; readonly requiredBytes: number };

/** Caps the complete application result, including its continuation and metadata. */
export function pageResult<T, R>(records: readonly T[], offset: number, cap: number,
  render: (items: readonly T[], next: number | null) => R, encode: ResultEncoding = identityEncoding): R | BudgetDiagnostic {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new WorkspaceFailure('invalidOutputBudget');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > records.length) throw new WorkspaceFailure('invalidContinuation');
  const page = (count: number) => render(records.slice(offset, offset + count),
    offset + count < records.length ? offset + count : null);
  const remaining = records.length - offset;
  const size = (value: unknown) => serializedBytes(encode(value));
  const complete = page(remaining);
  if (size(complete) <= cap) return complete;
  const emptySize = size(page(0));
  if (emptySize > cap) return { kind: 'outputBudgetTooSmall', requiredBytes: emptySize };
  const firstSize = size(page(1));
  if (firstSize > cap) {
    const diagnostic: BudgetDiagnostic = { kind: 'recordTooLarge', requiredBytes: firstSize,
      remedy: 'Request a narrower record or increase maxOutputBytes.' };
    return size(diagnostic) <= cap ? diagnostic : { kind: 'outputBudgetTooSmall', requiredBytes: size(diagnostic) };
  }
  let low = 1, high = remaining - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(page(mid)) <= cap) low = mid;
    else high = mid - 1;
  }
  return page(low);
}
