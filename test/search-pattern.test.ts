import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const workspaceReply = Compile(Type.Object({ id: Type.String() }));
const searchReply = Compile(Type.Object({ kind: Type.Literal('search'), counts: Type.Object({ matchingLines: Type.Integer() }), files: Type.Array(Type.Object({
  lines: Type.Array(Type.Object({ number: Type.Integer(), matching: Type.Boolean() })),
})) }));
const errorReply = Compile(Type.Object({ kind: Type.Literal('error'), code: Type.String(), message: Type.String() }));
const correctionReply = Compile(Type.Object({ warning: Type.String() }));

test('public file_search uses source pattern inference, trimming and literal flexible spaces', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-search-pattern-'));
  const root = join(base, 'root'), out = join(base, 'out'); await mkdir(root); await mkdir(out);
  await writeFile(join(root, 'example.txt'), 'anchor\n^anchor$\nfunc()\nlet\tfoo.bar\nlet\tfooXbar\none\ttwo\none\t two\nend\\E\tvalue\nANCHOR\n' +
    '++\na++b\n ++ \nleftover\nupright\nleft\nright\naleft\nrightward\ncafé\ncafétéria\ndécafé\néwordé\nword\nsword\n' +
    'cafe\u0301 cafe\u0301\nCAFÉ\nStraße\n' +
    'multi-start\nmiddle\nmulti-end\ncrlf-start\r\nmiddle\r\ncrlf-end\r\ncr-start\rmiddle\rcr-end\r' +
    'nul\0spaced\tneedle\nfunc)\n');
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(base, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], git: null, discovery: null,
    defaultMaxOutputBytes: 12000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config],
    cwd: '/', env: { PATH: base }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'source-search-pattern', version: '1' });
  const observations: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = workspaceReply.Parse((await client.callTool({ name: 'workspace_declare', arguments: {
      spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out },
    } })).structuredContent);
    const cases = [
      { query: { text: ' \n^anchor$\u0085' }, lines: [1, 9] },
      { query: { kind: 'literal', text: ' ^anchor$ ' }, lines: [2] },
      { query: { text: 'func()' }, lines: [3] },
      { query: { kind: 'literal', text: 'let foo.bar' }, lines: [4] },
      { query: { text: 'one  two' }, lines: [7] },
      { query: { kind: 'literal', text: 'end\\E value' }, lines: [8] },
      { query: { kind: 'literal', text: 'ne tw', wholeWord: true }, lines: [6, 7] },
      { query: { kind: 'regex', text: '^anchor$', caseSensitive: true }, lines: [1] },
      { query: { kind: 'literal', text: '++', wholeWord: true }, lines: [11] },
      { query: { kind: 'literal', text: '++', wholeWord: false }, lines: [10, 11, 12] },
      { query: { kind: 'regex', text: 'left|right', wholeWord: true }, lines: [13, 14, 15, 16] },
      { query: { kind: 'regex', text: '(?:left|right)', wholeWord: true }, lines: [15, 16] },
      { query: { kind: 'literal', text: 'left', wholeWord: true }, lines: [15] },
      { query: { kind: 'literal', text: 'café', wholeWord: true }, lines: [19, 26] },
      { query: { kind: 'literal', text: 'word', wholeWord: true }, lines: [23] },
      { query: { kind: 'literal', text: 'café' }, lines: [19, 20, 21, 25, 26] },
      { query: { kind: 'literal', text: 'café', caseSensitive: true }, lines: [19, 20, 21, 25] },
      { query: { kind: 'literal', text: 'STRASSE' }, lines: [27] },
      { query: { kind: 'regex', text: 'multi-start\\nmiddle' }, lines: [28] },
      { query: { kind: 'regex', text: 'crlf-start\\r\\nmiddle' }, lines: [31] },
      { query: { kind: 'regex', text: '(?=left)' }, lines: [] },
      { query: { kind: 'literal', text: 'spaced needle' }, lines: [37] },
      { query: { kind: 'literal', text: 'needle', wholeWord: true }, lines: [37] },
    ];
    for (const item of cases) {
      const found = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
        input: { mode: 'content', query: item.query } } });
      assert.equal(found.isError, false, JSON.stringify(found));
      const reply = searchReply.Parse(found.structuredContent);
      assert.deepEqual(reply.files.flatMap(file => file.lines.filter(line => line.matching).map(line => line.number)), item.lines, JSON.stringify(item.query));
      observations.push({ query: item.query, reply: found });
      const counted = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
        input: { mode: 'content', query: item.query, countOnly: true } } });
      assert.equal(counted.isError, false, JSON.stringify(counted));
      const totals = searchReply.Parse(counted.structuredContent);
      assert.equal(totals.counts.matchingLines, item.lines.length, JSON.stringify(item.query));
      assert.deepEqual(totals.files, []);
      observations.push({ query: item.query, countOnly: counted });
    }
    const repairCases = [
      { pattern: '^func\\\\(', lines: [3] },
      { pattern: '^func(', lines: [3] },
      { pattern: '^func)', lines: [38] },
    ];
    for (const item of repairCases) for (const countOnly of [false, true]) {
      const found = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
        input: { mode: 'content', query: { kind: 'regex', text: item.pattern }, countOnly } } });
      assert.equal(found.isError, false, JSON.stringify(found));
      const result = searchReply.Parse(found.structuredContent);
      assert.equal(result.counts.matchingLines, item.lines.length);
      assert.deepEqual(result.files.flatMap(file => file.lines.filter(line => line.matching).map(line => line.number)), countOnly ? [] : item.lines);
      assert.equal(correctionReply.Parse(found.structuredContent).warning,
        'The content-search pattern was auto-corrected before running. Results may reflect a repaired or escaped version of the requested regex rather than the exact pattern you entered.');
      observations.push({ repairedPattern: item.pattern, countOnly, reply: found });
    }
    const blank = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
      input: { query: { text: '\u0085 \r\n' } } } });
    assert.equal(blank.isError, true);
    assert.deepEqual(errorReply.Parse(blank.structuredContent), { kind: 'error', code: 'invalidSearchPattern',
      message: "pattern cannot be empty; provide a non-empty search term. If you intend to enumerate files, use get_file_tree or specify a path mode with a wildcard like '*.swift'." });
    observations.push({ blank });
    const admissionCases = [
      { mode: 'content', text: 'a'.repeat(2000), wholeWord: false, rejected: false },
      { mode: 'content', text: 'a'.repeat(2001), wholeWord: false, rejected: true },
      { mode: 'content', text: 'a'.repeat(2000), wholeWord: true, rejected: false },
      { mode: 'content', text: 'a'.repeat(2001), wholeWord: true, rejected: true },
      { mode: 'content', text: 'a'.repeat(1998) + ' b', wholeWord: false, rejected: false },
      { mode: 'content', text: 'a'.repeat(1999) + ' b', wholeWord: false, rejected: true },
      { mode: 'content', text: 'e\u0301'.repeat(2000), wholeWord: false, rejected: false },
      { mode: 'content', text: 'e\u0301'.repeat(2001), wholeWord: false, rejected: true },
      { mode: 'path', text: 'a'.repeat(2001), wholeWord: false, rejected: false },
      { mode: 'both', text: 'a'.repeat(2001), wholeWord: false, rejected: false },
    ];
    for (const item of admissionCases) for (const countOnly of [false, true]) {
      const found = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
        input: { mode: item.mode, query: { kind: 'literal', text: item.text, wholeWord: item.wholeWord }, countOnly } } });
      assert.equal(found.isError, item.rejected, JSON.stringify({ item, countOnly, found }));
      if (item.rejected) {
        assert.deepEqual(errorReply.Parse(found.structuredContent), { kind: 'error', code: 'invalidSearchPattern',
          message: 'Search pattern was rejected because it is either excessively large or shaped in a way that is known to cause catastrophic back-tracking in the regex engine.  Please simplify the pattern or rewrite it using non-nested quantifiers.' });
      } else {
        assert.equal(searchReply.Parse(found.structuredContent).counts.matchingLines, 0);
      }
      observations.push({ admission: item, countOnly, reply: found });
    }
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/search-pattern-public.json', JSON.stringify(observations, null, 2) + '\n');
  } finally { await client.close(); }
});
