import type { SearchRequest } from '../contracts/exploration.js';
import type { PreparedSearchPattern, SearchCorrection } from '../contracts/search-pattern.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { prepareText, type PreparedText } from './lines.js';
import { serializedBytes } from './output-budget.js';
import type { prepareSearch } from './search-query.js';
import type { SearchFile } from './search.js';
import { scanLiteralContent, scanRegexContent } from './content-search.js';
import { unavailableRootCode } from '../workspace/source-access.js';
import { NativeFailure } from '../native/bridge-client.js';

type SearchPlan = Awaited<ReturnType<typeof prepareSearch>>;
type RecoveryAttempt = Awaited<ReturnType<WorkspaceOperation['prepareSearchRecovery']>>['attempts'][number];

async function compileRecovery(operation: WorkspaceOperation, request: SearchRequest, attempt: RecoveryAttempt): Promise<SearchCorrection> {
  if (attempt.kind === 'literal') return { kind: 'unchanged' };
  const compiled = await operation.compileRegexContent({ kind: 'compileRegexContent', pattern: attempt.pattern,
    caseSensitive: request.query.caseSensitive, wholeWord: request.query.kind !== 'glob' && request.query.wholeWord });
  if (compiled.kind === 'regexSearchError') throw new WorkspaceFailure('searchFailed', { message: compiled.message });
  return compiled.correction;
}

function matchedContext(text: PreparedText, matching: ReadonlySet<number>, before: number, after: number): SearchFile['lines'] {
  const intervals: { start: number; end: number }[] = [];
  for (const line of matching) {
    const start = Math.max(1, line - before), end = Math.min(text.lines.length, line + after);
    const previous = intervals.at(-1);
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
    else intervals.push({ start, end });
  }
  const lines: SearchFile['lines'][number][] = [];
  for (const interval of intervals) {
    for (let number = interval.start; number <= interval.end; number++) {
      lines.push({ number, text: text.lines[number - 1]!.text, matching: matching.has(number) });
    }
  }
  return lines;
}

async function scanPass(operation: WorkspaceOperation, request: SearchRequest, plan: SearchPlan,
  content: PreparedSearchPattern | null, offset: number) {
  const { candidates, matchedPaths } = plan;
  const { maxOutputBytes } = request;
  const matches = candidates.map(() => ({ matchingLines: 0 }));
  const limitations: { root: string; path: string; code: string }[] = [];
  const records: SearchFile[] = [];
  let current = 0, matchedFiles = 0, retainedBytes = 0, contentMatches = 0;
  let text: PreparedText | null = null;
  let matching = new Set<number>();
  const retain = () => !request.countOnly && matchedFiles >= offset && retainedBytes <= maxOutputBytes;
  const flush = () => {
    const candidate = candidates[current], match = matches[current];
    if (!candidate || !match) throw new WorkspaceFailure('searchProtocolError');
    if (matchedPaths.has(candidate) || match.matchingLines) {
      if (retain()) {
        const lines = text ? matchedContext(text, matching, request.before, request.after) : [];
        const record = { root: candidate.root, path: candidate.path, identity: candidate.identity,
          pathMatch: matchedPaths.has(candidate), matchingLines: match.matchingLines, lines };
        retainedBytes += serializedBytes(record); records.push(record);
      }
      matchedFiles++;
    }
    current++; text = null; matching = new Set();
  };
  for (const [index, candidate] of candidates.entries()) {
    // Each candidate is revalidated even for count-only and path-only continuations.
    if (content === null) { await operation.readRawSource(candidate); continue; }
    try {
      const source = await operation.readSource(candidate);
      const prepared = prepareText(source.text);
      const found = content.isRegex
        ? await scanRegexContent(operation, source.text, prepared.lines.length, { pattern: content.text,
          caseSensitive: request.query.caseSensitive, wholeWord: request.query.kind !== 'glob' && request.query.wholeWord,
          countOnly: request.countOnly, limit: request.maxResults - contentMatches })
        : await scanLiteralContent(operation, source.text, prepared.lines.length, { pattern: content.text,
          caseSensitive: request.query.caseSensitive, wholeWord: request.query.kind !== 'glob' && request.query.wholeWord,
          countOnly: request.countOnly, limit: request.maxResults - contentMatches });
      matches[index]!.matchingLines = found.matchingLines;
      contentMatches += found.matchingLines;
      if (retain()) { text = prepared; matching = new Set(found.matches); }
    } catch (error) {
      if (error instanceof WorkspaceFailure && ['binarySource', 'decodeFailed'].includes(error.code)) {
        limitations.push({ root: candidate.root, path: candidate.path, code: error.code });
      } else {
        const code = error instanceof NativeFailure ? unavailableRootCode(error) : null;
        if (request.continuation !== null || code === null) throw error;
        limitations.push({ root: candidate.root, path: candidate.path, code });
      }
    }
    flush();
  }
  while (current < candidates.length) flush();
  return { records, limitations, contentMatches, matchedFiles };
}

export async function searchContent(operation: WorkspaceOperation, request: SearchRequest, plan: SearchPlan, offset: number) {
  const initial = plan.mode === 'path' || plan.content.kind === 'failed' ? null : plan.raw;
  let primary = await scanPass(operation, request, plan, initial, offset);
  let correction: SearchCorrection = plan.content.kind === 'ready' ? plan.content.correction : { kind: 'unchanged' };
  if (initial === null || primary.contentMatches > 0) return { ...primary, correction };
  const recovery = await operation.prepareSearchRecovery({ kind: 'prepareSearchRecovery', pattern: initial.text, isRegex: initial.isRegex });
  for (const attempt of recovery.attempts) {
    try {
      const compiled = await compileRecovery(operation, request, attempt);
      if (compiled.kind === 'corrected') correction = compiled;
      const result = await scanPass(operation, request, plan, { text: attempt.pattern, isRegex: attempt.kind !== 'literal' }, offset);
      if (attempt.kind === 'literal') primary = result;
      if (result.contentMatches > 0) {
        correction = { kind: 'corrected', warning: recovery.warning };
        return { ...result, correction };
      }
    } catch (error) {
      // Only the source normalized stage ignores a pattern failure; host authority and cancellation still apply.
      if (attempt.kind !== 'normalizedRegex' || !(error instanceof WorkspaceFailure) || error.code !== 'searchFailed') throw error;
    }
  }
  return { ...primary, correction };
}
