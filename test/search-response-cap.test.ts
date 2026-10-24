import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { toolJSON } from './fixtures/tool-json.js';

const cases = Compile(Type.Array(Type.Object({ name: Type.String(), maxResults: Type.Integer(), paths: Type.Array(Type.String()),
  matches: Type.Array(Type.Object({ filePath: Type.String(), lineNumber: Type.Integer(), lineText: Type.String() })),
  expected: Type.Object({ includedLines: Type.Array(Type.Integer()), includedPaths: Type.Array(Type.String()),
    limitHit: Type.Boolean(), sizeLimitHit: Type.Boolean(), omittedContent: Type.Integer(), omittedPaths: Type.Integer(),
    perFileTotals: Type.Array(Type.Object({ path: Type.String(), count: Type.Integer() })) }) })))
  .Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-search-response-cap/cases.json'), 'utf8')));
const workspace = Compile(Type.Object({ id: Type.String() }));
const summaryReply = Compile(Type.Object({ counts: Type.Object({ totalMatches: Type.Integer(), matchingLines: Type.Integer(),
  totalFiles: Type.Integer(), matchedFiles: Type.Integer(), pathMatches: Type.Integer() }), pathMatchLines: Type.Array(Type.String()),
  files: Type.Array(Type.Unknown()) }));
const paginatedReplyBytes = 50_000;
const completeReplyBytes = 1_000_000;
const reply = Compile(Type.Object({ kind: Type.Literal('search'), counts: Type.Object({ matchingLines: Type.Integer() }),
  limitHit: Type.Boolean(), sizeLimitHit: Type.Optional(Type.Boolean()), omittedContentMatches: Type.Optional(Type.Integer()),
  perFileTotals: Type.Array(Type.Object({ path: Type.String(), count: Type.Integer() })),
  omittedPathMatches: Type.Optional(Type.Integer()), continuation: Type.Union([Type.Null(),
    Type.Object({ digest: Type.String(), offset: Type.Integer() })]), files: Type.Array(Type.Object({ root: Type.String(),
    path: Type.String(), pathMatch: Type.Boolean(), lines: Type.Array(Type.Object({ number: Type.Integer(),
      text: Type.String(), matching: Type.Boolean() })) })) }));

test('public search retains the source character cap before byte pagination and never continues into omitted matches', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-search-response-cap-'));
  const root = join(base, 'source'), output = join(base, 'output'), config = join(base, 'host.json');
  await mkdir(root); await mkdir(output);
  for (const item of cases) {
    const files = new Map<string, string[]>();
    for (const match of item.matches) {
      const lines = files.get(match.filePath) ?? [];
      lines.push(match.lineText); files.set(match.filePath, lines);
    }
    for (const [path, lines] of files) await writeFile(join(root, path.slice(2)), lines.join('\r\n') + '\r\n');
  }
  await writeFile(join(root, 'needle-b.swift'), 'no content match\r\n');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, git: null, discovery: null, defaultMaxOutputBytes: completeReplyBytes }));
  const client = new Client({ name: 'search-response-cap', version: '1' });
  const evidence = [];
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' }));
    const declared = await client.callTool({ name: 'workspace_declare', arguments: { spec: {
      roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] } } });
    assert.equal(declared.isError, false);
    const workspaceId = workspace.Parse(toolJSON(declared)).id;
    for (const item of cases) {
      evidence.push(await verifyCase(client, workspaceId, item));
    }
    await writeFile(join(root, 'summary-content.txt'), 'summaryNeedle\n');
    await writeFile(join(root, 'summaryNeedle-\uE000.txt'), 'summaryNeedle\n');
    await writeFile(join(root, 'summaryNeedle-😀.txt'), 'unrelated\n');
    for (const countOnly of [false, true]) {
      const response = await client.callTool({ name: 'file_search', arguments: { workspaceId,
        input: { mode: 'both', query: { kind: 'literal', text: 'summaryNeedle' }, countOnly } } });
      assert.equal(response.isError, false, JSON.stringify(response));
      assert(summaryReply.Check(toolJSON(response)), 'Search must retain distinct file counts and path identities');
      const result = summaryReply.Parse(toolJSON(response));
      assert.deepEqual(result.counts, { totalMatches: 4, matchingLines: 2, totalFiles: 2,
        matchedFiles: countOnly ? 2 : 3, pathMatches: 2 });
      if (countOnly) {
        assert.deepEqual(result.pathMatchLines, ['r/summaryNeedle-\uE000.txt', 'r/summaryNeedle-😀.txt']);
        assert.deepEqual(result.files, []);
      }
      evidence.push({ name: 'distinct-file-counts', countOnly, result });
    }
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/search-response-cap.json', JSON.stringify(evidence, null, 2) + '\n');
  } finally { await client.close(); }
});

async function verifyCase(client: Client, workspaceId: string, item: typeof cases[number]) {
  const paths = [...new Set(item.matches.map(match => match.filePath).concat(item.paths))];
  const input = { mode: item.paths.length ? 'both' : 'content', query: { kind: 'literal', text: 'needle' },
    maxResults: item.maxResults, filters: { paths }, before: 1, after: 1 };
  const foundLines: number[] = [], foundPaths: string[] = [];
  let continuation: { digest: string; offset: number } | null = null;
  do {
    const result = await client.callTool({ name: 'file_search', arguments: { workspaceId,
      maxOutputBytes: item.name === 'display-cap-before-transport-pagination' ? paginatedReplyBytes : completeReplyBytes,
      input: { ...input, continuation } } });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert(reply.Check(toolJSON(result)), `${item.name}: missing search reply fields`);
    const page = reply.Parse(toolJSON(result));
    assert.equal(page.counts.matchingLines, item.expected.includedLines.length);
    assert.equal(page.limitHit, item.expected.limitHit);
    assert.equal(page.sizeLimitHit ?? false, item.expected.sizeLimitHit);
    assert.equal(page.omittedContentMatches ?? 0, item.expected.omittedContent);
    assert.equal(page.omittedPathMatches ?? 0, item.expected.omittedPaths);
    assert.deepEqual(page.perFileTotals, item.expected.perFileTotals);
    const matches = collectPage(page, item.name);
    foundLines.push(...matches.lines); foundPaths.push(...matches.paths);
    if (page.continuation) assert(page.continuation.offset > (continuation?.offset ?? 0));
    continuation = page.continuation;
  } while (continuation);
  assert.deepEqual(foundLines, item.expected.includedLines, item.name);
  assert.deepEqual(foundPaths, item.expected.includedPaths, item.name);
  const counted = await client.callTool({ name: 'file_search', arguments: { workspaceId, input: { ...input, countOnly: true } } });
  assert.equal(counted.isError, false);
  const count = reply.Parse(toolJSON(counted));
  assert.equal(count.counts.matchingLines, item.matches.length);
  assert.equal(count.limitHit, false); assert.equal(count.sizeLimitHit ?? false, false); assert.deepEqual(count.files, []);
  return { name: item.name, foundLines, foundPaths, count: count.counts };
}

function collectPage(page: ReturnType<typeof reply.Parse>, name: string) {
  const lines: number[] = [], paths: string[] = [];
  for (const file of page.files) {
    if (name === 'long-ascii-content') {
      assert.equal(file.lines.at(-1)?.number, 8);
      assert.equal(file.lines.at(-1)?.matching, false);
    }
    if (file.pathMatch) paths.push(file.root + '/' + file.path);
    for (const line of file.lines) if (line.matching) {
      lines.push(line.number); assert(line.text.endsWith('\r\n'));
    }
  }
  return { lines, paths };
}
