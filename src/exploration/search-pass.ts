import type { SearchRequest } from '../contracts/exploration.js';
import type { PreparedSearchPattern, SearchCorrection, SearchDiagnostic } from '../contracts/search-pattern.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { prepareText, type PreparedText } from './lines.js';
import type { prepareSearch } from './search-query.js';
import type { SearchFile } from './search.js';
import { scanLiteralContent, scanRegexContent } from './content-search.js';
import { unavailableRootCode } from '../workspace/source-access.js';
import { NativeFailure } from '../native/bridge-client.js';
import { matchedContext } from './search-reply.js';
import { SearchPatternFailure } from './search-diagnostic.js';

type SearchPlan = Awaited<ReturnType<typeof prepareSearch>>;
type RecoveryAttempt = Awaited<ReturnType<WorkspaceOperation['prepareSearchRecovery']>>['attempts'][number];
interface ContentCorrection { current: SearchCorrection }

async function compileRecovery(operation: WorkspaceOperation, request: SearchRequest, attempt: RecoveryAttempt): Promise<SearchCorrection> {
  if (attempt.kind === 'literal') return { kind: 'unchanged' };
  const compiled = await operation.compileRegexContent({ kind: 'compileRegexContent', pattern: attempt.pattern,
    caseSensitive: request.query.caseSensitive, wholeWord: request.query.kind !== 'glob' && request.query.wholeWord });
  if (compiled.kind === 'regexSearchError') throw new SearchPatternFailure(compiled.diagnostic);
  return compiled.correction;
}

async function scanPass(operation: WorkspaceOperation, request: SearchRequest, plan: SearchPlan,
  content: PreparedSearchPattern | null) {
  const { candidates, matchedPaths } = plan;
  const matches = candidates.map(() => ({ matchingLines: 0 }));
  const limitations: { root: string; path: string; code: string }[] = [];
  const perFileErrors: { root: string; path: string; diagnostic: SearchDiagnostic }[] = [];
  const records: SearchFile[] = [];
  let current = 0, contentFiles = 0, contentMatches = 0;
  let text: PreparedText | null = null;
  let matching = new Set<number>();
  const flush = () => {
    const candidate = candidates[current], match = matches[current];
    if (!candidate || !match) throw new WorkspaceFailure('searchProtocolError');
    if (match.matchingLines) contentFiles++;
    if (matchedPaths.has(candidate) || match.matchingLines) {
      if (!request.countOnly) {
        const lines = text ? matchedContext(text.lines, matching, request.before, request.after) : [];
        const record = { root: candidate.root, path: candidate.path, identity: candidate.identity,
          pathMatch: matchedPaths.has(candidate), matchingLines: match.matchingLines, lines };
        records.push(record);
      }
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
      if (found.kind === 'regexSearchError' || found.kind === 'literalSearchError') {
        perFileErrors.push({ root: candidate.root, path: candidate.path, diagnostic: found.diagnostic });
      } else {
        matches[index]!.matchingLines = found.matchingLines;
        contentMatches += found.matchingLines;
        if (!request.countOnly) { text = prepared; matching = new Set(found.matches); }
      }
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
  return { records, limitations, contentMatches, contentFiles, perFileErrors };
}

export async function searchContent(operation: WorkspaceOperation, request: SearchRequest, plan: SearchPlan) {
  const correction: ContentCorrection = { current: plan.content.kind === 'ready' ? plan.content.correction : { kind: 'unchanged' } };
  try {
    const result = await recoverContent(operation, request, plan, correction);
    return { ...result, contentError: plan.content.kind === 'failed' ? plan.content.diagnostic : null };
  } catch (error) {
    if (!(error instanceof SearchPatternFailure) || plan.mode !== 'both' || plan.pathError !== null) throw error;
    const result = await scanPass(operation, request, plan, null);
    return { ...result, correction: correction.current, contentError: error.diagnostic };
  }
}

async function recoverContent(operation: WorkspaceOperation, request: SearchRequest, plan: SearchPlan, correction: ContentCorrection) {
  const initial = plan.mode === 'path' || plan.content.kind === 'failed' ? null : plan.raw;
  let primary = await scanPass(operation, request, plan, initial);
  if (initial === null || primary.contentMatches > 0) return { ...primary, correction: correction.current };
  const recovery = await operation.prepareSearchRecovery({ kind: 'prepareSearchRecovery', pattern: initial.text, isRegex: initial.isRegex });
  for (const attempt of recovery.attempts) {
    try {
      const compiled = await compileRecovery(operation, request, attempt);
      if (compiled.kind === 'corrected') correction.current = compiled;
      const result = await scanPass(operation, request, plan, { text: attempt.pattern, isRegex: attempt.kind !== 'literal' });
      if (attempt.kind === 'literal') primary = result;
      if (result.contentMatches > 0) {
        correction.current = { kind: 'corrected', warning: recovery.warning };
        return { ...result, correction: correction.current };
      }
    } catch (error) {
      // Only the source normalized stage ignores a pattern failure; host authority and cancellation still apply.
      if (attempt.kind !== 'normalizedRegex' || !(error instanceof SearchPatternFailure)) throw error;
    }
  }
  return { ...primary, correction: correction.current };
}
