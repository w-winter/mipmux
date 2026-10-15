import type { NativeOperation, NativeResult } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import type { PreparedText } from './lines.js';

type LiteralContentQuery = Omit<Extract<NativeOperation, { kind: 'scanLiteralLines' }>, 'kind' | 'lines'>;
type RegexContentQuery = Omit<Extract<NativeOperation, { kind: 'scanRegexContent' }>, 'kind' | 'text'>;
type ContentMatches = Pick<Extract<NativeResult, { kind: 'literalSearch' }>, 'matchingLines' | 'matches'>;

function validateMatches(result: ContentMatches, lineCount: number, countOnly: boolean): void {
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

export async function scanLiteralContent(operation: WorkspaceOperation, text: PreparedText, query: LiteralContentQuery) {
  const lines = text.searchText.split('\n').slice(0, text.lines.length);
  const result = await operation.scanLiteralLines({ kind: 'scanLiteralLines', lines, ...query });
  validateMatches(result, lines.length, query.countOnly);
  return result;
}

export async function scanRegexContent(operation: WorkspaceOperation, text: string, lineCount: number, query: RegexContentQuery) {
  const result = await operation.scanRegexContent({ kind: 'scanRegexContent', text, ...query });
  if (result.kind === 'regexSearchError') throw new WorkspaceFailure('searchFailed', { message: result.message });
  validateMatches(result, lineCount, query.countOnly);
  return result;
}
