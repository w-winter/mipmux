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
const searchReply = Compile(Type.Object({ kind: Type.Literal('search'), files: Type.Array(Type.Object({
  lines: Type.Array(Type.Object({ number: Type.Integer(), matching: Type.Boolean() })),
})) }));
const errorReply = Compile(Type.Object({ kind: Type.Literal('error'), code: Type.String(), message: Type.String() }));

test('public file_search uses source pattern inference, trimming and literal flexible spaces', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-search-pattern-'));
  const root = join(base, 'root'), out = join(base, 'out'); await mkdir(root); await mkdir(out);
  await writeFile(join(root, 'example.txt'), 'anchor\n^anchor$\nfunc()\nlet\tfoo.bar\nlet\tfooXbar\none\ttwo\none\t two\nend\\E\tvalue\nANCHOR\n');
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ cachePath: join(base, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], git: null, discovery: null,
    search: { executable: process.env.SMIP_TEST_RG ?? resolve('.smip-work/test-ripgrep/ripgrep-e89fff89ac9af12e8d4ce9d5fd07beb408ca730f/target/release/rg') },
    defaultMaxOutputBytes: 12000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
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
    ];
    for (const item of cases) {
      const found = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
        input: { mode: 'content', query: item.query } } });
      assert.equal(found.isError, false, JSON.stringify(found));
      const reply = searchReply.Parse(found.structuredContent);
      assert.deepEqual(reply.files.flatMap(file => file.lines.filter(line => line.matching).map(line => line.number)), item.lines, JSON.stringify(item.query));
      observations.push({ query: item.query, reply: found });
    }
    const blank = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
      input: { query: { text: '\u0085 \r\n' } } } });
    assert.equal(blank.isError, true);
    assert.deepEqual(errorReply.Parse(blank.structuredContent), { kind: 'error', code: 'invalidSearchPattern',
      message: "pattern cannot be empty; provide a non-empty search term. If you intend to enumerate files, use get_file_tree or specify a path mode with a wildcard like '*.swift'." });
    observations.push({ blank });
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/search-pattern-public.json', JSON.stringify(observations, null, 2) + '\n');
  } finally { await client.close(); }
});
