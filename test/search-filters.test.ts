import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { toolJSON } from './fixtures/tool-json.js';

const workspaceReply = Compile(Type.Object({ id: Type.String() }));
const searchReply = Compile(Type.Object({ kind: Type.Literal('search'), files: Type.Array(Type.Object({ path: Type.String() })) }));

test('public search filters preserve source dotted extensions and literal/wildmatch exclusions', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-search-filters-'));
  const root = join(base, 'root'), out = join(base, 'out'); await mkdir(root); await mkdir(out);
  const names = ['plain.swift', 'caps.SWIFT', 'README', 'sub/Ignore.swift', 'nested/deep/skip.swift', '[ab].swift', 'a.swift', 'drop/inner.swift'];
  for (const name of names) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), 'needle\n');
  }
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(base, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], git: null, discovery: null,
    defaultMaxOutputBytes: 100000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'source-search-filters', version: '1' });
  const observations: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = workspaceReply.Parse(toolJSON(await client.callTool({ name: 'workspace_declare', arguments: {
      spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out },
    } })));
    const cases = [
      { filters: { extensions: ['.swift'] }, expected: names.filter(name => name.endsWith('.swift')) },
      { filters: { extensions: ['.SWIFT'] }, expected: ['caps.SWIFT'] },
      { filters: { extensions: ['.'] }, expected: ['README'] },
      { filters: { exclude: ['IGNORE'] }, expected: names.filter(name => name !== 'sub/Ignore.swift') },
      { filters: { exclude: ['drop*'] }, expected: names.filter(name => name !== 'drop/inner.swift') },
      { filters: { exclude: ['*.SWIFT'] }, expected: ['README'] },
      { filters: { exclude: ['[ab].swift'] }, expected: names.filter(name => name !== '[ab].swift') },
      { filters: { exclude: [''] }, expected: names },
    ];
    for (const item of cases) {
      const found = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
        input: { mode: 'content', query: { text: 'needle', caseSensitive: true }, filters: item.filters } } });
      assert.equal(found.isError, false, JSON.stringify(found));
      const result = searchReply.Parse(toolJSON(found));
      assert.deepEqual(result.files.map(file => file.path), item.expected.toSorted(), JSON.stringify(item.filters));
      observations.push({ filters: item.filters, result: found });
    }
    const paths = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
      input: { query: { kind: 'glob', text: '*.swift' }, maxResults: 1,
        filters: { extensions: ['.swift'], exclude: ['IGNORE', '[ab].swift'] } } } });
    assert.equal(paths.isError, false);
    assert.deepEqual(searchReply.Parse(toolJSON(paths)).files.map(file => file.path), ['a.swift']);
    observations.push({ paths });
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/search-filters-public.json', JSON.stringify(observations, null, 2) + '\n');
  } finally { await client.close(); }
});
