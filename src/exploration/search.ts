import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { searchValidator, type SearchRequest } from '../contracts/exploration.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { SourceIdentity } from '../contracts/workspace.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { prepareText, type PreparedText } from './lines.js';
import { runRipgrep, encodedText } from './ripgrep.js';
import { pageIdentity, pageOffset } from './continuation.js';
import { pageResult, serializedBytes, type ResultEncoding } from './output-budget.js';
import type { PreparedSearchPattern } from '../contracts/search-pattern.js';
import { prepareSearch } from './search-query.js';
import { scanLiteralContent, scanRegexContent } from './content-search.js';

export interface SearchFile {
  readonly root: string; readonly path: string; readonly identity: SourceIdentity;
  readonly pathMatch: boolean;
  readonly matchingLines: number;
  readonly lines: readonly { number: number; text: string; matching: boolean }[];
}

function patternFlags(base: readonly string[], pattern: PreparedSearchPattern, caseSensitive: boolean): string[] {
  return [...base, caseSensitive ? '--case-sensitive' : '--ignore-case',
    ...(!pattern.isRegex ? ['--fixed-strings'] : []), '-e', pattern.text];
}

export async function fileSearch(operation: WorkspaceOperation, request: SearchRequest, encode?: ResultEncoding) {
  if (!searchValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  const configured = operation.runtime.options.search;
  if (!configured) throw new WorkspaceFailure('searchNotConfigured');
  const { executable } = configured;
  await runRipgrep(operation.runtime.supervisor, executable, ['--pcre2-version'], '/', '', operation.signal, () => {}, true);
  const admitted = operation.snapshot.entries.filter(entry => entry.kind === 'file').filter(entry => {
    if (entry.visibility !== 'discoverable') return false;
    const filters = request.filters;
    return (!filters.roots.length || filters.roots.includes(entry.root)) &&
      (!filters.directories.length || filters.directories.some(directory => directory.root === entry.root && entry.path.startsWith(directory.path + '/'))) &&
      (!filters.include.length || filters.include.some(glob => posix.matchesGlob(entry.path, glob)));
  });
  const pattern = await prepareSearch(operation, request, admitted);
  const { candidates, matchedPaths } = pattern;
  const { maxOutputBytes, continuation, ...settings } = request;
  const digest = pageIdentity(operation.snapshot, settings, candidates.map(entry => ({ root: entry.root, path: entry.path,
    identity: entry.identity })));
  const offset = pageOffset(continuation, digest);
  const matches = candidates.map(() => ({ matchingLines: 0, lastLine: 0 }));
  const useRipgrep = !pattern.raw.isRegex && pattern.content.isRegex;
  const flags = ['--pcre2', '--json', '--no-config', '--encoding', 'none', '--no-ignore', '--hidden', '--threads', '1', '--sort', 'path'];
  const contentFlags = patternFlags(flags, pattern.content, request.query.caseSensitive);
  const limitations: { root: string; path: string; code: string }[] = [];
  const workRoot = join(operation.runtime.options.cachePath, 'v1/work');
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(workRoot, 'search-'));
  let temporaryCount = 0;
  try {
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
          const intervals: { start: number; end: number }[] = [];
          if (text) for (const line of matching) {
            const start = Math.max(1, line - request.before), end = Math.min(text.lines.length, line + request.after);
            const previous = intervals.at(-1);
            if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
            else intervals.push({ start, end });
          }
          const lines: SearchFile['lines'][number][] = [];
          if (text) for (const interval of intervals) {
            for (let number = interval.start; number <= interval.end; number++) {
              lines.push({ number, text: text.lines[number - 1]!.text, matching: matching.has(number) });
            }
          }
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
      if (pattern.mode === 'path') { await operation.readRawSource(candidate); continue; }
      try {
        const source = await operation.readSource(candidate);
        const prepared = prepareText(source.text);
        if (useRipgrep) {
          const path = join(directory, String(index).padStart(String(candidates.length).length, '0'));
          await writeFile(path, prepared.searchText, { flag: 'wx', mode: 0o600 }); temporaryCount++;
        } else {
          const found = pattern.raw.isRegex
            ? await scanRegexContent(operation, source.text, prepared.lines.length, { pattern: pattern.raw.text,
              caseSensitive: request.query.caseSensitive, wholeWord: request.query.kind !== 'glob' && request.query.wholeWord,
              countOnly: request.countOnly, limit: request.maxResults - contentMatches })
            : await scanLiteralContent(operation, prepared, { pattern: pattern.content.text,
              caseSensitive: request.query.caseSensitive, countOnly: request.countOnly, limit: request.maxResults - contentMatches });
          matches[index]!.matchingLines = found.matchingLines;
          contentMatches += found.matchingLines;
          if (retain()) { text = prepared; matching = new Set(found.matches); }
        }
      } catch (error) {
        if (!(error instanceof WorkspaceFailure) || !['binarySource', 'decodeFailed'].includes(error.code)) throw error;
        limitations.push({ root: candidate.root, path: candidate.path, code: error.code });
      }
      if (!useRipgrep) flush();
    }
    if (pattern.mode !== 'path' && pattern.raw.isRegex && !candidates.length) {
      await scanRegexContent(operation, '', 0, { pattern: pattern.raw.text, caseSensitive: request.query.caseSensitive,
        wholeWord: request.query.kind !== 'glob' && request.query.wholeWord, countOnly: request.countOnly, limit: request.maxResults });
    }
    if (pattern.mode !== 'path' && useRipgrep && temporaryCount) {
      await runRipgrep(operation.runtime.supervisor, executable, [...contentFlags, '--', '.'], directory, '', operation.signal, async match => {
        const filename = encodedText(match.path);
        if (!/^\.\/[0-9]+$/.test(filename)) throw new WorkspaceFailure('searchProtocolError');
        const index = Number(filename.slice(2));
        if (index < current || index >= candidates.length) throw new WorkspaceFailure('searchProtocolError');
        while (current < index) flush();
        const found = matches[index]!;
        if (match.line_number <= found.lastLine) throw new WorkspaceFailure('searchProtocolError');
        found.lastLine = match.line_number;
        if (!request.countOnly && contentMatches >= request.maxResults) return;
        contentMatches++;
        found.matchingLines++;
        if (retain()) {
          text ??= prepareText((await operation.readSource(candidates[index]!)).text);
          if (match.line_number > text.lines.length) throw new WorkspaceFailure('searchProtocolError');
          matching.add(match.line_number);
        }
      });
    }
    if (pattern.mode === 'content' && useRipgrep && !temporaryCount) {
      await runRipgrep(operation.runtime.supervisor, executable, contentFlags, directory, '', operation.signal,
        () => { throw new WorkspaceFailure('searchProtocolError'); });
    }
    while (current < candidates.length) flush();
    if (offset > matchedFiles) throw new WorkspaceFailure('invalidContinuation');
    const matchingLines = matches.reduce((sum, match) => sum + match.matchingLines, 0);
    const counts = { totalMatches: matchingLines + matchedPaths.size, matchingLines, pathMatches: matchedPaths.size, matchedFiles };
    return pageResult(records, 0, maxOutputBytes, (files) => ({
      kind: 'search' as const, inventoryDigest: operation.snapshot.inventoryDigest,
      engine: pattern.mode === 'path' ? 'RPCE path' : pattern.content.isRegex ? 'PCRE2' : 'Foundation',
      newlineView: pattern.raw.isRegex ? 'Original decoded text; CRLF, CR and LF define lines'
        : 'CRLF and CR become LF; all other decoded text is preserved', counts,
      limitHit: !request.countOnly && (contentMatches >= request.maxResults || matchedPaths.size >= request.maxResults),
      returnedMatchingLines: files.reduce((sum, file) => sum + file.matchingLines, 0), files, limitations,
      truncated: !request.countOnly && offset + files.length < matchedFiles,
      continuation: request.countOnly || offset + files.length === matchedFiles ? null : { digest, offset: offset + files.length },
  }), encode);
  } finally {
    await rm(directory, { recursive: true });
  }
}
