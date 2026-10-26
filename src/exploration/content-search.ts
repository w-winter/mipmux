import type { NativeResult } from '../contracts/native.js';
import { WorkspaceFailure } from '../workspace/values.js';

type ContentMatches = Pick<Extract<NativeResult, { kind: 'literalSearch' }>, 'matchingLines' | 'matches'>;

/** Rejects a scan whose matches are unordered or beyond the scanned text, or whose counts disagree with its matches. */
export function validateMatches(result: ContentMatches, lineCount: number, countOnly: boolean): void {
  let previous = 0;
  for (const match of result.matches) {
    if (match <= previous || match > lineCount) throw new WorkspaceFailure('searchProtocolError');
    previous = match;
  }
  if (result.matchingLines > lineCount) throw new WorkspaceFailure('searchProtocolError');
  if (countOnly) {
    if (result.matches.length) throw new WorkspaceFailure('searchProtocolError');
  } else if (result.matchingLines !== result.matches.length) {
    throw new WorkspaceFailure('searchProtocolError');
  }
}

