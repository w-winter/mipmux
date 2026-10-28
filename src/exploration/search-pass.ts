import type { SearchRequest } from '../contracts/exploration.js';
import type { NativeResult, NativeSearchSourceOutcome } from '../contracts/native.js';
import type { PreparedSearchPattern, SearchCorrection, SearchDiagnostic } from '../contracts/search-pattern.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { prepareText } from './lines.js';
import type { prepareSearch } from './search-query.js';
import type { SearchFile } from './search.js';
import { validateMatches } from './content-search.js';
import { unavailableRootCode } from '../workspace/source-access.js';
import { NativeFailure } from '../native/bridge-client.js';
import { matchedContext } from './search-reply.js';
import { SearchPatternFailure } from './search-diagnostic.js';

type SearchPlan = Awaited<ReturnType<typeof prepareSearch>>;
type Candidate = SearchPlan['candidates'][number];
type DecodedOutcome = Extract<NativeSearchSourceOutcome, { kind: 'decoded' }>;
/** A scan outcome whose text is reduced to its line count and the lines a search record shows around its matches. */
type ScannedOutcome = Exclude<NativeSearchSourceOutcome, DecodedOutcome> |
  (Omit<DecodedOutcome, 'text'> & { readonly context: { readonly lineCount: number; readonly lines: SearchFile['lines'] } | null });
// A file returned without text has no matches to place, so only match order and counts are checked.
const unknownLineCount = Number.MAX_SAFE_INTEGER;

/** Keeps of a decoded file's text only what its search record needs, so a scan holds no file's full text. */
function scannedOutcome(request: SearchRequest, outcome: NativeSearchSourceOutcome): ScannedOutcome {
  if (outcome.kind !== 'decoded') return outcome;
  const { text, ...rest } = outcome;
  if (text === null) return { ...rest, context: null };
  const { lines } = prepareText(text);
  const matching = new Set('matches' in outcome.result ? outcome.result.matches : []);
  return { ...rest, context: { lineCount: lines.length, lines: matchedContext(lines, matching, request.before, request.after) } };
}

/** An unavailable-root failure becomes a limitation on a first page; any other failure, or one on a continuation, fails the search. */
function unavailableLimitation(request: SearchRequest, candidate: Candidate, error: NativeFailure) {
  const code = unavailableRootCode(error);
  if (request.continuation !== null || code === null) throw error;
  return { root: candidate.root, path: candidate.path, code };
}

/** Checks a decoded file against its snapshot decoding and the scanner's protocol; returns its diagnostic or matches. */
function decodedScan(candidate: Candidate, outcome: Extract<ScannedOutcome, { kind: 'decoded' }>, countOnly: boolean) {
  const { decoding } = candidate, { textIdentity } = outcome;
  if (decoding.kind !== 'decoded' || decoding.identity.sha256 !== textIdentity.sha256 || decoding.identity.byteCount !== textIdentity.byteCount) {
    throw new WorkspaceFailure('pipelineChanged', { root: candidate.root, path: candidate.path });
  }
  const found = outcome.result;
  if (found.kind === 'regexSearchError' || found.kind === 'literalSearchError') return found;
  if (!countOnly && found.matchingLines > 0 && outcome.context === null) throw new WorkspaceFailure('searchProtocolError');
  validateMatches(found, outcome.context?.lineCount ?? unknownLineCount, countOnly);
  return { ...found, lines: outcome.context?.lines ?? [] };
}
type RecoveryAttempt = Extract<NativeResult, { kind: 'searchRecovery' }>['attempts'][number];
interface ContentCorrection { current: SearchCorrection }

async function compileRecovery(operation: WorkspaceOperation, request: SearchRequest, attempt: RecoveryAttempt): Promise<SearchCorrection> {
  if (attempt.kind === 'literal') return { kind: 'unchanged' };
  const compiled = await operation.projectNative({ kind: 'compileRegexContent', pattern: attempt.pattern,
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
  let lines: SearchFile['lines'] = [];
  const flush = () => {
    const candidate = candidates[current], match = matches[current];
    if (!candidate || !match) throw new WorkspaceFailure('searchProtocolError');
    if (match.matchingLines) contentFiles++;
    if (matchedPaths.has(candidate) || match.matchingLines) {
      if (!request.countOnly) {
        const record = { root: candidate.root, path: candidate.path, identity: candidate.identity,
          pathMatch: matchedPaths.has(candidate), matchingLines: match.matchingLines, lines };
        records.push(record);
      }
    }
    current++; lines = [];
  };
  // A first page uses the policy that its refresh just captured. A continuation revalidates every candidate's controlling
  // policy, even for path-only and count-only pages.
  if (request.continuation !== null) await operation.revalidateSearchSources(candidates);
  if (content === null) {
    // A path-only pass reads no file contents.
    while (current < candidates.length) flush();
    return { records, limitations, contentMatches, contentFiles, perFileErrors };
  }
  // One native request reads, decodes and scans the candidates; binary and undecodable files are skipped unreported.
  const scanned: ScannedOutcome[] = [];
  await operation.scanSearchSources(candidates.map(({ root, path, identity }) => ({ root, path, identity })),
    { pattern: content.text, isRegex: content.isRegex, caseSensitive: request.query.caseSensitive,
      wholeWord: request.query.kind !== 'glob' && request.query.wholeWord, countOnly: request.countOnly, limit: request.maxResults },
    outcome => scanned.push(scannedOutcome(request, outcome)));
  for (const [index, candidate] of candidates.entries()) {
    const outcome = scanned[index]!;
    if (outcome.kind === 'failed') limitations.push(unavailableLimitation(request, candidate, new NativeFailure(outcome.code, outcome.errno)));
    else if (outcome.kind === 'decoded') {
      const found = decodedScan(candidate, outcome, request.countOnly);
      if ('diagnostic' in found) perFileErrors.push({ root: candidate.root, path: candidate.path, diagnostic: found.diagnostic });
      else {
        matches[index]!.matchingLines = found.matchingLines;
        contentMatches += found.matchingLines;
        if (!request.countOnly) lines = found.lines;
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
  const recovery = await operation.projectNative({ kind: 'prepareSearchRecovery', pattern: initial.text, isRegex: initial.isRegex });
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
