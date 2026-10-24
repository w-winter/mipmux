import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { copyContext } from './fixtures/copy-context.js';
import { SearchInput } from '../src/contracts/exploration.js';
import { toolJSON } from './fixtures/tool-json.js';

const workspaceReply = Compile(Type.Object({ id: Type.String() }));
const reply = Compile(Type.Object({ kind: Type.Literal('search'), error: Type.Optional(Type.String()),
  suggestion: Type.Optional(Type.String()), warning: Type.Optional(Type.String()), searchedFiles: Type.Optional(Type.Integer()), scopedFileCount: Type.Integer(),
  counts: Type.Object({ totalMatches: Type.Integer(), totalFiles: Type.Integer(), matchedFiles: Type.Integer() }),
  pathMatchLines: Type.Array(Type.String()), files: Type.Array(Type.Object({ path: Type.String() })),
  pathError: Type.Optional(Type.Unknown()), contentError: Type.Optional(Type.Unknown()),
  perFileErrors: Type.Array(Type.Object({ root: Type.String(), path: Type.String(), diagnostic: Type.Unknown() })) }));
const bracketIssue = 'Invalid regex pattern. The regular expression could not be compiled. A character class is missing its closing `]`.';
const bracketSuggestion = "Review the pattern for typos or unmatched groups. Escape literal characters with '\\\\'.";
const pathSuggestion = 'The specified path filter resolved to no files in the current workspace. Use get_file_tree to inspect the project structure and confirm the path.';
const phaseDiagnostic = (phase: string) => ({ kind: 'pattern', issue: phase + ' fixture issue', suggestion: phase + ' fixture suggestion' });
const regexWarning = 'The content-search pattern was auto-corrected before running. Results may reflect a repaired or escaped version of the requested regex rather than the exact pattern you entered.';

async function connect(fixture: boolean) {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-search-diagnostics-'));
  const root = join(base, 'root'), out = join(base, 'out'); await mkdir(root); await mkdir(out);
  await writeFile(join(root, 'example.txt'), 'hello\n');
  await writeFile(join(root, 'other.ts'), 'unrelated\n');
  const native = resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`);
  const proxy = join(base, 'bridge');
  if (fixture) await writeFile(proxy, `#!/bin/sh\nexec "${process.execPath}" "${resolve('test/fixtures/search-diagnostics-proxy.mjs')}" "$@"\n`, { mode: 0o700 });
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000,
    credentialPaths: [], nativeExecutable: fixture ? proxy : native, nativeEnvironment: fixture ? { MIPMUX_NATIVE: native } : {},
    terminationGraceMs: 100, git: null, discovery: null, defaultMaxOutputBytes: 100000 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'source-search-diagnostics', version: '1' });
  await client.connect(transport);
  const workspace = workspaceReply.Parse(toolJSON(await client.callTool({ name: 'workspace_declare', arguments: {
    spec: { roots: [{ name: 'r', absolutePath: root }], outputRoot: out, exclusions: [] } } })));
  return { client, search: (input: Static<typeof SearchInput>) => client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id, input } }) };
}

test('public search diagnostics and searched-file metadata follow Source DTO semantics', async t => {
  const { client, search } = await connect(false);
  const observations: unknown[] = [];
  try {
    await t.test('recognized compilation failure is a search value and the next query works', async () => {
      const found = await search({ mode: 'content', query: { kind: 'regex', text: '[' } });
      observations.push({ found });
      assert.equal(found.isError, false);
      const result = reply.Parse(toolJSON(found));
      assert.equal(result.error, bracketIssue); assert.equal(result.suggestion, bracketSuggestion);
      assert.equal(result.searchedFiles, undefined); assert.equal(result.counts.totalMatches, 0);
      assert.deepEqual(result.files, []);
      const next = await search({ mode: 'content', query: { kind: 'literal', text: 'hello' } });
      assert.equal(next.isError, false); assert.equal(reply.Parse(toolJSON(next)).counts.totalMatches, 1);
      observations.push({ next });
    });
    const cases = [
      { name: 'successful', text: 'hello', filters: {}, scoped: 2, searched: 2, matches: 1, suggestion: undefined },
      { name: 'zero hits', text: 'absent', filters: {}, scoped: 2, searched: 2, matches: 0, suggestion: undefined },
      { name: 'empty path admission', text: 'hello', filters: { paths: ['absent/'] }, scoped: 0, searched: 0, matches: 0, suggestion: pathSuggestion },
      { name: 'extension filtering', text: 'hello', filters: { paths: ['example.txt'], extensions: ['.ts'] }, scoped: 1, searched: 0, matches: 0, suggestion: undefined },
      { name: 'exclusion filtering', text: 'hello', filters: { paths: ['example.txt'], exclude: ['example'] }, scoped: 1, searched: 0, matches: 0, suggestion: undefined },
    ];
    for (const item of cases) for (const countOnly of [false, true]) await t.test(`${item.name}, countOnly=${countOnly}`, async () => {
      const found = await search({ mode: 'content', query: { kind: 'literal', text: item.text }, filters: item.filters, countOnly });
      observations.push({ item, countOnly, found }); assert.equal(found.isError, false);
      const result = reply.Parse(toolJSON(found));
      assert.equal(result.scopedFileCount, item.scoped); assert.equal(result.searchedFiles, item.searched);
      assert.equal(result.suggestion, item.suggestion); assert.equal(result.counts.totalMatches, item.matches);
      assert.equal(result.counts.totalFiles, item.matches); assert.equal(result.counts.matchedFiles, countOnly ? 0 : item.matches);
    });
    await t.test('empty query and complexity admission remain failures', async () => {
      for (const text of ['', 'a'.repeat(2001)]) {
        const found = await search({ mode: 'content', query: { kind: 'literal', text } });
        observations.push({ text, found }); assert.equal(found.isError, true);
      }
    });
  } finally {
    await client.close(); await mkdir('test-output', { recursive: true });
    await writeFile('test-output/search-diagnostics-public.json', JSON.stringify(observations, null, 2) + '\n');
  }
});

test('public search preserves healthy phases and per-file pattern diagnostics at the native boundary', async t => {
  const { client, search } = await connect(true);
  const observations: unknown[] = [];
  try {
    const cases = [
      { text: 'fixture-path-failure', mode: 'both', matches: 1, error: undefined, pathError: phaseDiagnostic('path'), contentError: undefined },
      { text: 'fixture-content-failure', mode: 'both', matches: 1, error: undefined, pathError: undefined, contentError: phaseDiagnostic('content') },
      { text: 'fixture-both-failure', mode: 'both', matches: 0, error: 'content fixture issue', pathError: undefined, contentError: undefined },
      { text: 'fixture-path-zero', mode: 'both', matches: 0, error: undefined, pathError: undefined, contentError: phaseDiagnostic('content') },
      { text: 'fixture-content-zero', mode: 'both', matches: 0, error: undefined, pathError: phaseDiagnostic('path'), contentError: undefined },
      { text: 'fixture-path-failure', mode: 'path', matches: 0, error: 'path fixture issue', pathError: undefined, contentError: undefined },
    ] as const;
    for (const item of cases) await t.test(item.text + ':' + item.mode, async () => {
      const found = await search({ mode: item.mode, query: { kind: 'regex', text: item.text }, filters: { extensions: ['.txt'] } });
      observations.push({ item, found }); assert.equal(found.isError, false);
      const result = reply.Parse(toolJSON(found));
      assert.equal(result.counts.totalMatches, item.matches); assert.equal(result.error, item.error);
      assert.deepEqual(result.pathError, item.pathError); assert.deepEqual(result.contentError, item.contentError);
      if (!item.error) assert.equal(result.searchedFiles, 1);
      if (item.text === 'fixture-path-failure' && item.mode === 'both') assert.deepEqual(result.files.map(file => file.path), ['example.txt']);
    });
    await t.test('per-file failure is retained after all-zero recovery, not promoted to a phase failure', async () => {
      const found = await search({ mode: 'content', query: { kind: 'regex', text: 'fixture-per-file' } });
      observations.push({ found }); assert.equal(found.isError, false);
      const result = reply.Parse(toolJSON(found));
      assert.equal(result.error, undefined); assert.equal(result.contentError, undefined);
      assert.deepEqual(result.perFileErrors, [{ root: 'r', path: 'example.txt', diagnostic: phaseDiagnostic('file') }]);
    });
    await t.test('recovery phase failure keeps the compilation correction and healthy path phase', async () => {
      const found = await search({ mode: 'both', query: { kind: 'regex', text: 'fixture-recovery\\.fail' } });
      observations.push({ found }); assert.equal(found.isError, false);
      const result = reply.Parse(toolJSON(found));
      assert.equal(result.error, undefined); assert.deepEqual(result.contentError, phaseDiagnostic('content'));
      assert.equal(result.warning, regexWarning);
    });
    await t.test('both-phase failure during recovery still selects content', async () => {
      const found = await search({ mode: 'both', query: { kind: 'regex', text: 'fixture-both-recovery\\.fail' } });
      observations.push({ found }); assert.equal(found.isError, false);
      const result = reply.Parse(toolJSON(found));
      assert.equal(result.error, 'content fixture issue'); assert.equal(result.suggestion, 'content fixture suggestion');
    });
    for (const [text, code] of [['fixture-native-failure', 'nativeOperationFailed'], ['fixture-protocol-failure', 'nativeProtocolError'],
      ['fixture-authorization-failure', 'invalidSourceCapability']] as const) await t.test(text, async () => {
      const found = await search({ mode: 'content', query: { kind: 'regex', text } });
      observations.push({ text, found }); assert.equal(found.isError, true);
      assert.deepEqual(toolJSON(found), { kind: 'error', code });
      assert.equal(JSON.stringify(found).includes('PRIVATE_DETAIL'), false);
      const next = await search({ mode: 'content', query: { kind: 'literal', text: 'hello' } });
      assert.equal(next.isError, false); assert.equal(reply.Parse(toolJSON(next)).counts.totalMatches, 1);
    });
  } finally {
    await client.close(); await mkdir('test-output', { recursive: true });
    await writeFile('test-output/search-diagnostics-boundary.json', JSON.stringify(observations, null, 2) + '\n');
  }
});
