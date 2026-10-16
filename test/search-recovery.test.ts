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
const searchReply = Compile(Type.Object({ counts: Type.Object({ matchingLines: Type.Integer() }),
  warning: Type.Optional(Type.String()), files: Type.Array(Type.Object({ path: Type.String(),
    lines: Type.Array(Type.Object({ number: Type.Integer(), matching: Type.Boolean() })) })) }));
const warnings = new Map([
  ['regex', 'The content-search pattern was auto-corrected before running. Results may reflect a repaired or escaped version of the requested regex rather than the exact pattern you entered.'],
  ['literal', 'The content-search pattern was auto-corrected before running. Results may reflect a de-escaped literal interpretation of the text you entered.'],
]);

test('public content recovery retries the whole query only after zero primary matches', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-search-recovery-'));
  const root = join(base, 'root'), out = join(base, 'out'); await mkdir(root); await mkdir(out);
  const files = {
    'recover/a.txt': 'frame(\ntag.value\nitem[ab].\nnormalize\n',
    'recover/z.txt': 'frame(\ntag.value\n',
    'literal-primary/a.txt': 'frame(\n',
    'literal-primary/z.txt': 'frame\\(\n',
    'regex-primary/a.txt': 'tag.value\n',
    'regex-primary/z.txt': 'tag\\Xvalue\n',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text);
  }
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ cachePath: join(base, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], git: null, discovery: null,
    defaultMaxOutputBytes: 100000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config],
    cwd: '/', env: { PATH: base }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'source-search-recovery', version: '1' });
  const observations: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = workspaceReply.Parse((await client.callTool({ name: 'workspace_declare', arguments: {
      spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out },
    } })).structuredContent);
    const cases = [
      { kind: 'literal', text: 'frame\\(', directory: 'recover', paths: ['recover/a.txt', 'recover/z.txt'], lines: [1, 1], corrected: true },
      { kind: 'literal', text: 'frame\\\\(', directory: 'recover', paths: ['recover/a.txt', 'recover/z.txt'], lines: [1, 1], corrected: true },
      { kind: 'regex', text: 'tag\\\\.value', directory: 'recover', paths: ['recover/a.txt', 'recover/z.txt'], lines: [2, 2], corrected: true },
      { kind: 'regex', text: '|normalize', directory: 'recover', paths: ['recover/a.txt'], lines: [4], corrected: true },
      { kind: 'regex', text: 'item[ab]\\.', directory: 'recover', paths: ['recover/a.txt'], lines: [3], corrected: true },
      { kind: 'literal', text: 'frame\\(', directory: 'literal-primary', paths: ['literal-primary/z.txt'], lines: [1], corrected: false },
      { kind: 'regex', text: 'tag\\\\.value', directory: 'regex-primary', paths: ['regex-primary/z.txt'], lines: [1], corrected: false },
      { kind: 'literal', text: '\\\\(', directory: 'recover', paths: [], lines: [], corrected: false },
      { kind: 'literal', text: 'absent\\(', directory: 'recover', paths: [], lines: [], corrected: false },
      { kind: 'regex', text: 'absent[ab]\\.', directory: 'recover', paths: [], lines: [], corrected: false },
      { kind: 'regex', text: '^absent(', directory: 'recover', paths: [], lines: [], corrected: true },
    ];
    for (const item of cases) for (const countOnly of [false, true]) {
      const found = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
        input: { mode: 'content', query: { kind: item.kind, text: item.text }, countOnly,
          filters: { directories: [{ root: 'r', path: item.directory }] } } } });
      assert.equal(found.isError, false, JSON.stringify(found));
      const result = searchReply.Parse(found.structuredContent);
      assert.equal(result.counts.matchingLines, item.lines.length, JSON.stringify(item));
      assert.deepEqual(result.files.map(file => file.path), countOnly ? [] : item.paths, JSON.stringify(item));
      assert.deepEqual(result.files.flatMap(file => file.lines.filter(line => line.matching).map(line => line.number)), countOnly ? [] : item.lines);
      assert.equal(result.warning, item.corrected ? warnings.get(item.kind) : undefined);
      observations.push({ item, countOnly, result });
    }
    for (const maxResults of [0, 1]) {
      const found = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
        input: { mode: 'content', query: { kind: 'literal', text: 'frame\\(' }, maxResults,
          filters: { directories: [{ root: 'r', path: 'recover' }] } } } });
      assert.equal(found.isError, false, JSON.stringify(found));
      const result = searchReply.Parse(found.structuredContent);
      assert.equal(result.counts.matchingLines, maxResults);
      assert.equal(result.warning !== undefined, maxResults > 0);
      observations.push({ maxResults, result });
    }
    const maxPatternLength = 2000;
    const quoteOverflow = 'a'.repeat(maxPatternLength - 3) + '\\.';
    for (const text of ['[abc', quoteOverflow]) {
      const invalid = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
        input: { mode: 'content', query: { kind: 'regex', text } } } });
      assert.equal(invalid.isError, true);
      observations.push({ text, invalid });
    }
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/search-recovery-public.json', JSON.stringify(observations, null, 2) + '\n');
  } finally { await client.close(); }
});
