import type { SourcePath } from '../contracts/inventory.js';
import type { SearchRequest } from '../contracts/exploration.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import type { SearchFile } from './search.js';

/** Lines and match numbers are ascending; only context around the retained matches is emitted. */
export function matchedContext(lines: readonly { number: number; text: string }[], matching: ReadonlySet<number>,
  before: number, after: number): SearchFile['lines'] {
  const intervals: { start: number; end: number }[] = [];
  for (const number of matching) {
    const start = number - before, end = number + after, previous = intervals.at(-1);
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
    else intervals.push({ start, end });
  }
  const result: SearchFile['lines'][number][] = [];
  let index = 0;
  for (const line of lines) {
    while (index < intervals.length && line.number > intervals[index]!.end) index++;
    if (index === intervals.length) break;
    if (line.number >= intervals[index]!.start) {
      result.push({ number: line.number, text: line.text, matching: matching.has(line.number) });
    }
  }
  return result;
}

const key = (source: SourcePath) => JSON.stringify([source.root, source.path]);

export async function projectSearchReply(operation: WorkspaceOperation, request: SearchRequest,
  scan: { readonly records: readonly SearchFile[]; readonly contentMatches: number; readonly contentFiles: number },
  matchedPaths: ReadonlySet<SourcePath>) {
  const { records } = scan;
  const paths = [...matchedPaths];
  const matches = records.flatMap(file => file.lines.filter(line => line.matching).map(line => ({
    filePath: file.root + '/' + file.path, lineNumber: line.number - 1,
    lineText: line.text.replace(/\r\n$|\r$|\n$/u, ''),
  })));
  const displayedPaths = paths.map(file => file.root + '/' + file.path);
  const projected = await operation.projectSearchReply(request.countOnly
    ? { kind: 'countSearchReply', contentMatches: scan.contentMatches, contentFiles: scan.contentFiles, paths: displayedPaths }
    : { kind: 'projectSearchReply', matches, paths: displayedPaths, maxResults: request.maxResults });
  if (!request.countOnly && (projected.contentCount > matches.length || projected.pathCount > paths.length ||
    projected.omittedContentMatches !== matches.length - projected.contentCount ||
    projected.omittedPathMatches !== paths.length - projected.pathCount ||
    projected.sizeLimitHit !== (projected.omittedContentMatches + projected.omittedPathMatches > 0))) {
    throw new WorkspaceFailure('searchProtocolError');
  }
  const result = { contentMatches: projected.contentCount, pathMatches: projected.pathCount,
    totalFiles: projected.totalFiles, matchedFiles: projected.matchedFiles, pathMatchLines: projected.pathMatchLines,
    limitHit: projected.limitHit, sizeLimitHit: projected.sizeLimitHit,
    omittedContentMatches: projected.omittedContentMatches, omittedPathMatches: projected.omittedPathMatches,
    perFileTotals: projected.perFileTotals };
  if (!projected.sizeLimitHit) return { ...result, records };
  const includedPaths = new Set(paths.slice(0, projected.pathCount).map(key));
  let remaining = projected.contentCount;
  const files = records.flatMap(file => {
    const matching = file.lines.filter(line => line.matching).slice(0, remaining);
    remaining -= matching.length;
    const pathMatch = includedPaths.has(key(file));
    if (!matching.length && !pathMatch) return [];
    return [{ ...file, pathMatch, matchingLines: matching.length,
      lines: matchedContext(file.lines, new Set(matching.map(line => line.number)), request.before, request.after) }];
  });
  return { ...result, records: files };
}
