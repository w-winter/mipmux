import type { NativeOperation } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import type { PreparedText } from './lines.js';

type LiteralContentQuery = Omit<Extract<NativeOperation, { kind: 'scanLiteralLines' }>, 'kind' | 'lines'>;

export async function scanLiteralContent(operation: WorkspaceOperation, text: PreparedText, query: LiteralContentQuery) {
  const lines = text.searchText.split('\n').slice(0, text.lines.length);
  const result = await operation.scanLiteralLines({ kind: 'scanLiteralLines', lines, ...query });
  let previous = 0;
  for (const match of result.matches) {
    if (match.number <= previous || match.number > lines.length) throw new WorkspaceFailure('searchProtocolError');
    previous = match.number;
  }
  if (result.matchingLines > lines.length || result.occurrences < result.matchingLines) {
    throw new WorkspaceFailure('searchProtocolError');
  }
  if (query.countOnly) {
    if (result.matches.length) throw new WorkspaceFailure('searchProtocolError');
  } else if (result.matchingLines !== result.matches.length ||
    result.occurrences !== result.matches.reduce((sum, match) => sum + match.occurrences, 0)) {
    throw new WorkspaceFailure('searchProtocolError');
  }
  return result;
}
