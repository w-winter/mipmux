import type { NativeOperation, NativeResult } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';

type LiteralContentQuery = Omit<Extract<NativeOperation, { kind: 'scanLiteralLines' }>, 'kind' | 'text'>;
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

export async function scanLiteralContent(operation: WorkspaceOperation, text: string, lineCount: number, query: LiteralContentQuery) {
  const result = await operation.scanLiteralLines({ kind: 'scanLiteralLines', text, ...query });
  if (result.kind === 'literalSearch') validateMatches(result, lineCount, query.countOnly);
  return result;
}

export async function scanRegexContent(operation: WorkspaceOperation, text: string, lineCount: number, query: RegexContentQuery) {
  const result = await operation.scanRegexContent({ kind: 'scanRegexContent', text, ...query });
  if (result.kind === 'regexSearch') validateMatches(result, lineCount, query.countOnly);
  return result;
}
