import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import type { SearchRequest } from '../src/contracts/exploration.js';
import { serializedBytes } from '../src/exploration/output-budget.js';

test('real search modes and output continuations preserve complete counts and reject stale inputs', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-pages-'));
  const root = join(base, 'root'); await mkdir(root); await mkdir(join(base, 'out'));
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(root, name), '\uFEFFcafé\r\n ++ \rx café x\ncaféteria\nlast');
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } });
  try {
    const handle = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: join(base, 'out') }, new AbortController().signal);
    const operation = await handle.openOperation(new AbortController().signal);
    const query = { mode: 'content', query: { kind: 'literal', text: 'CAFÉ', caseSensitive: false, wholeWord: true },
      filters: { roots: [], paths: [], exclude: [], extensions: [] }, before: 0, after: 0, countOnly: false,
      maxResults: 50, maxOutputBytes: 10000, continuation: null } satisfies SearchRequest;
    const full = await operation.fileSearch(query);
    if (full.kind !== 'search') assert.fail('Missing search');
    assert.equal(full.counts.matchingLines, 6); assert.equal(full.counts.totalMatches, 6);
    assert.equal(full.files[0]?.lines[0]?.text, 'café\r\n');
    const cap = serializedBytes({ ...full, files: full.files.slice(0, 1), returnedMatchingLines: 2,
      truncated: true, continuation: { digest: '0'.repeat(64), offset: 1 } });
    const paths: string[] = [];
    let continuation = null as SearchRequest['continuation'];
    do {
      const page = await operation.fileSearch({ ...query, maxOutputBytes: cap, continuation });
      if (page.kind !== 'search') assert.fail(JSON.stringify(page));
      assert(serializedBytes(page) <= cap); assert.deepEqual(page.counts, full.counts);
      paths.push(...page.files.map(file => file.path)); continuation = page.continuation;
    } while (continuation !== null);
    assert.deepEqual(paths, ['a.txt', 'b.txt', 'c.txt']);
    const first = await operation.fileSearch({ ...query, maxOutputBytes: cap });
    if (first.kind !== 'search' || !first.continuation) assert.fail('Missing continuation');
    await assert.rejects(operation.fileSearch({ ...query, query: { ...query.query, text: 'other' }, continuation: first.continuation }), /staleContinuation/);
    const count = await operation.fileSearch({ ...query, countOnly: true });
    if (count.kind !== 'search') assert.fail('Missing counts');
    assert.deepEqual(count.counts, { ...full.counts, matchedFiles: 0 }); assert.deepEqual(count.files, []); assert.equal(count.truncated, false);
    const both = await operation.fileSearch({ ...query, mode: 'both', query: { kind: 'literal', text: 'a', caseSensitive: true, wholeWord: false },
      filters: { ...query.filters, roots: ['r'], paths: ['a.*'], extensions: ['.txt'] } });
    if (both.kind !== 'search') assert.fail('Missing combined search');
    assert.deepEqual(both.files.map(file => file.path), ['a.txt']); assert.equal(both.files[0]?.pathMatch, true);
    assert.equal(both.counts.matchingLines, 4);
    const glob = await operation.fileSearch({ ...query, mode: 'path', query: { kind: 'glob', text: '*.txt', caseSensitive: false },
      filters: { ...query.filters, exclude: ['b.*'] } });
    if (glob.kind !== 'search') assert.fail('Missing glob search');
    assert.deepEqual(glob.files.map(file => file.path), ['a.txt', 'c.txt']);
    const punctuation = await operation.fileSearch({ ...query, query: { kind: 'literal', text: '++', caseSensitive: true, wholeWord: true } });
    if (punctuation.kind !== 'search') assert.fail('Missing punctuation match');
    assert.equal(punctuation.counts.totalMatches, 0);
    const regex = await operation.fileSearch({ ...query, query: { kind: 'regex', text: '(?<=x )café', caseSensitive: true, wholeWord: true } });
    if (regex.kind !== 'search') assert.fail('Missing regex match');
    assert.equal(regex.counts.totalMatches, 3);
    for (const paths of [[], ['absent.*']]) {
      const invalid = await operation.fileSearch({ ...query, filters: { ...query.filters, paths },
        query: { kind: 'regex', text: '[', caseSensitive: true, wholeWord: false } });
      if (invalid.kind !== 'search' || !('error' in invalid)) assert.fail('Missing pattern diagnostic');
      assert.equal(invalid.error, 'Invalid regex pattern. The regular expression could not be compiled. A character class is missing its closing `]`.');
    }
    const readQuery = { root: 'r', path: 'a.txt', start_line: null, offset: null, limit: null, maxOutputBytes: 10000, continuation: null };
    const read = await operation.readFile(readQuery);
    if (read.kind !== 'read') assert.fail('Missing read');
    const readCap = serializedBytes({ ...read, lines: read.lines.slice(0, 1), content: read.lines[0]!.text, returnedRange: { start: 1, end: 1 },
      firstLine: 1, lastLine: 1, returnedLineCount: 1,
      truncated: true, continuation: { digest: '0'.repeat(64), offset: 1 } });
    const readPage = await operation.readFile({ ...readQuery, maxOutputBytes: readCap });
    if (readPage.kind !== 'read' || !readPage.continuation) assert.fail('Missing read page');
    await handle.refresh(new AbortController().signal);
    const later = await handle.openOperation(new AbortController().signal);
    await assert.rejects(later.readFile({ ...readQuery, continuation: readPage.continuation }), /staleContinuation/);
    await later.close();
    const currentPage = await operation.fileSearch({ ...query, maxOutputBytes: cap });
    if (currentPage.kind !== 'search' || !currentPage.continuation) assert.fail('Missing current continuation');
    await writeFile(join(root, 'a.txt'), 'changed');
    await assert.rejects(operation.fileSearch({ ...query, continuation: currentPage.continuation }), /sourceChanged/);
    await operation.close(); await handle.close();
  } finally { await runtime.close(); }
});
