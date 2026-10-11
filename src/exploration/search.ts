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

export interface SearchFile {
  readonly root: string; readonly path: string; readonly identity: SourceIdentity;
  readonly pathMatch: boolean; readonly pathOccurrences: number; readonly occurrences: number;
  readonly matchingLines: number;
  readonly lines: readonly { number: number; text: string; matching: boolean }[];
}

export async function fileSearch(operation: WorkspaceOperation, request: SearchRequest, encode?: ResultEncoding) {
  if (!searchValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  const configured = operation.runtime.options.search;
  if (!configured) throw new WorkspaceFailure('searchNotConfigured');
  const { executable } = configured;
  await runRipgrep(operation.runtime.supervisor, executable, ['--pcre2-version'], '/', '', operation.signal, () => {}, true);
  const candidates = operation.snapshot.entries.filter(entry => entry.kind === 'file').filter(entry => {
    const filters = request.filters;
    return (!filters.roots.length || filters.roots.includes(entry.root)) &&
      (!filters.directories.length || filters.directories.some(directory => directory.root === entry.root && entry.path.startsWith(directory.path + '/'))) &&
      (!filters.include.length || filters.include.some(glob => posix.matchesGlob(entry.path, glob))) &&
      !filters.exclude.some(glob => posix.matchesGlob(entry.path, glob)) &&
      (!filters.extensions.length || filters.extensions.includes(posix.extname(entry.path).slice(1)));
  });
  const { maxOutputBytes, continuation, ...settings } = request;
  const digest = pageIdentity(operation.snapshot, settings, candidates.map(entry => ({ root: entry.root, path: entry.path,
    identity: entry.identity })));
  const offset = pageOffset(continuation, digest);
  const matches = candidates.map(() => ({ pathOccurrences: 0, occurrences: 0, matchingLines: 0, lastLine: 0 }));
  const flags = ['--pcre2', '--json', '--no-config', '--encoding', 'none', '--no-ignore', '--hidden', '--threads', '1', '--sort', 'path'];
  if (request.query.kind !== 'glob') {
    flags.push(request.query.caseSensitive ? '--case-sensitive' : '--ignore-case');
    if (request.query.kind === 'literal') flags.push('--fixed-strings');
    if (request.query.wholeWord) flags.push('--word-regexp');
    flags.push('-e', request.query.text);
  }
  const limitations: { root: string; path: string; code: string }[] = [];
  const workRoot = join(operation.runtime.options.cachePath, 'v1/work');
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(workRoot, 'search-'));
  let temporaryCount = 0;
  try {
    for (const [index, candidate] of candidates.entries()) {
      // Each candidate is revalidated even for count-only and path-only continuations.
      if (request.mode === 'path') { await operation.readRawSource(candidate); continue; }
      try {
        const source = await operation.readSource(candidate);
        const text = prepareText(source.text);
        const path = join(directory, String(index).padStart(String(candidates.length).length, '0'));
        await writeFile(path, text.searchText, { flag: 'wx', mode: 0o600 }); temporaryCount++;
      } catch (error) {
        if (!(error instanceof WorkspaceFailure) || !['binarySource', 'decodeFailed'].includes(error.code)) throw error;
        limitations.push({ root: candidate.root, path: candidate.path, code: error.code });
      }
    }
    if (request.mode === 'path' || request.mode === 'both') {
      if (request.query.kind === 'glob') {
        candidates.forEach((candidate, index) => { if (posix.matchesGlob(candidate.path, request.query.text)) matches[index]!.pathOccurrences = 1; });
      } else {
        await runRipgrep(operation.runtime.supervisor, executable, [...flags, '--null-data'], directory,
          candidates.map(candidate => candidate.path + '\0').join(''), operation.signal, match => {
            const found = matches[match.line_number - 1];
            if (!found) throw new WorkspaceFailure('searchProtocolError');
            found.pathOccurrences += match.submatches.length;
          });
      }
    }
    const records: SearchFile[] = [];
    let current = 0, matchedFiles = 0, retainedBytes = 0;
    let text: PreparedText | null = null;
    let matching = new Set<number>();
    const retain = () => !request.countOnly && matchedFiles >= offset && retainedBytes <= maxOutputBytes;
    const flush = () => {
      const candidate = candidates[current], match = matches[current];
      if (!candidate || !match) throw new WorkspaceFailure('searchProtocolError');
      if (match.pathOccurrences || match.occurrences) {
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
            pathMatch: match.pathOccurrences > 0, pathOccurrences: match.pathOccurrences,
            occurrences: match.occurrences, matchingLines: match.matchingLines, lines };
          retainedBytes += serializedBytes(record); records.push(record);
        }
        matchedFiles++;
      }
      current++; text = null; matching = new Set();
    };
    if (request.mode !== 'path' && temporaryCount) {
      await runRipgrep(operation.runtime.supervisor, executable, [...flags, '--', '.'], directory, '', operation.signal, async match => {
        const filename = encodedText(match.path);
        if (!/^\.\/[0-9]+$/.test(filename)) throw new WorkspaceFailure('searchProtocolError');
        const index = Number(filename.slice(2));
        if (index < current || index >= candidates.length) throw new WorkspaceFailure('searchProtocolError');
        while (current < index) flush();
        const found = matches[index]!;
        if (match.line_number <= found.lastLine) throw new WorkspaceFailure('searchProtocolError');
        found.occurrences += match.submatches.length; found.matchingLines++; found.lastLine = match.line_number;
        if (retain()) {
          text ??= prepareText((await operation.readSource(candidates[index]!)).text);
          if (match.line_number > text.lines.length) throw new WorkspaceFailure('searchProtocolError');
          matching.add(match.line_number);
        }
      });
    }
    if (request.mode === 'content' && !temporaryCount) {
      await runRipgrep(operation.runtime.supervisor, executable, flags, directory, '', operation.signal,
        () => { throw new WorkspaceFailure('searchProtocolError'); });
    }
    while (current < candidates.length) flush();
    if (offset > matchedFiles) throw new WorkspaceFailure('invalidContinuation');
    const counts = { occurrences: matches.reduce((sum, match) => sum + match.occurrences + match.pathOccurrences, 0),
      matchingLines: matches.reduce((sum, match) => sum + match.matchingLines, 0), matchedFiles };
    return pageResult(records, 0, maxOutputBytes, (files) => ({
      kind: 'search' as const, inventoryDigest: operation.snapshot.inventoryDigest, engine: 'PCRE2',
      newlineView: 'CRLF and CR become LF; all other decoded text is preserved', counts,
      returnedMatchingLines: files.reduce((sum, file) => sum + file.matchingLines, 0), files, limitations,
      truncated: !request.countOnly && offset + files.length < matchedFiles,
      continuation: request.countOnly || offset + files.length === matchedFiles ? null : { digest, offset: offset + files.length },
  }), encode);
  } finally {
    await rm(directory, { recursive: true });
  }
}
