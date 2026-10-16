import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const workspaceReply = Compile(Type.Object({ id: Type.String() }));
const searchReply = Compile(Type.Object({ kind: Type.Literal('search'), counts: Type.Object({ matchingLines: Type.Integer() }),
  limitHit: Type.Optional(Type.Boolean()), files: Type.Array(Type.Object({ root: Type.String(), path: Type.String(),
    pathMatch: Type.Boolean(), matchingLines: Type.Integer() })) }));

test('public search routes auto patterns and preserves native path candidates, physical ordering and result limits', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-search-routing-'));
  const a = join(base, 'a'), z = join(base, 'z'), out = join(base, 'out');
  await mkdir(a); await mkdir(z); await mkdir(out);
  const files = [
    { root: a, path: 'Foo.swift', text: '' }, { root: a, path: 'nested/Foo.swift', text: '' },
    { root: a, path: 'src/Foo.swift.more', text: '' }, { root: a, path: 'Needle.swift', text: '' },
    { root: a, path: 'docs/note.txt', text: 'Needle\n'.repeat(65) },
    { root: z, path: 'Foo.swift', text: '' }, { root: z, path: 'src/BAR.SWIFT', text: '' },
    { root: z, path: 'docs/foofoo.txt', text: '' }, { root: z, path: 'line\nending.txt', text: '' },
    { root: z, path: '👩‍💻.txt', text: '' },
    { root: a, path: 'docs/open(.txt', text: '' }, { root: a, path: 'docs/close).txt', text: '' },
    { root: a, path: 'docs/[abc.txt', text: '' },
  ];
  for (const file of files) {
    await mkdir(join(file.root, file.path, '..'), { recursive: true });
    await writeFile(join(file.root, file.path), file.text);
  }
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ cachePath: join(base, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], git: null, discovery: null,
    defaultMaxOutputBytes: 100000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'source-search-routing', version: '1' });
  const observations: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = workspaceReply.Parse((await client.callTool({ name: 'workspace_declare', arguments: {
      spec: { roots: [{ name: 'zAlias', absolutePath: a }, { name: 'aAlias', absolutePath: z }], exclusions: [], outputRoot: out },
    } })).structuredContent);
    const swiftFiles = ['zAlias/Foo.swift', 'zAlias/Needle.swift', 'zAlias/nested/Foo.swift', 'zAlias/src/Foo.swift.more', 'aAlias/Foo.swift', 'aAlias/src/BAR.SWIFT'];
    const cases = [
      { input: { query: { text: '*.swift' } }, paths: swiftFiles },
      { input: { query: { kind: 'glob', text: '*.swift' } }, paths: swiftFiles },
      { input: { mode: 'path', query: { kind: 'regex', text: '*.swift' } }, paths: swiftFiles },
      { input: { mode: 'path', query: { kind: 'literal', text: 'Foo' }, maxResults: 2 }, paths: ['zAlias/Foo.swift', 'zAlias/nested/Foo.swift'] },
      { input: { query: { kind: 'glob', text: '*.swift', caseSensitive: true } }, paths: swiftFiles.filter(path => !path.endsWith('BAR.SWIFT')) },
      { input: { mode: 'path', query: { text: '^aAlias/' } }, paths: ['aAlias/Foo.swift', 'aAlias/docs/foofoo.txt', 'aAlias/line\nending.txt', 'aAlias/src/BAR.SWIFT', 'aAlias/👩‍💻.txt'] },
      { input: { mode: 'path', query: { kind: 'regex', text: '(?<=/)Foo\\.swift$' } }, paths: ['zAlias/Foo.swift', 'zAlias/nested/Foo.swift', 'aAlias/Foo.swift'] },
      { input: { mode: 'path', query: { kind: 'literal', text: 'foo' } }, paths: ['zAlias/Foo.swift', 'zAlias/nested/Foo.swift', 'zAlias/src/Foo.swift.more', 'aAlias/Foo.swift', 'aAlias/docs/foofoo.txt'] },
      { input: { mode: 'path', query: { kind: 'literal', text: basename(base) } }, paths: [] },
      { input: { query: { text: '👩‍💻' } }, paths: ['aAlias/👩‍💻.txt'] },
      { input: { mode: 'path', query: { kind: 'regex', text: '^docs/open\\\\(' } }, paths: ['zAlias/docs/open(.txt'] },
      { input: { mode: 'path', query: { kind: 'regex', text: '^docs/open(' } }, paths: ['zAlias/docs/open(.txt'] },
      { input: { mode: 'path', query: { kind: 'regex', text: '^docs/close)\\.txt$' } }, paths: ['zAlias/docs/close).txt'] },
      { input: { mode: 'path', query: { kind: 'regex', text: '[abc' } }, paths: ['zAlias/docs/[abc.txt'] },
      { input: { mode: 'path', query: { kind: 'regex', text: '^[*' } }, paths: [] },
      { input: { mode: 'path', query: { kind: 'regex', text: '^ending' } }, paths: [] },
    ];
    for (const item of cases) {
      const found = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id, input: item.input } });
      assert.equal(found.isError, false, JSON.stringify(found));
      const result = searchReply.Parse(found.structuredContent);
      assert.deepEqual(result.files.map(file => file.root + '/' + file.path), item.paths, JSON.stringify(item.input));
      assert(result.files.every(file => file.pathMatch));
      observations.push({ input: item.input, result });
    }
    for (const limit of [0, -1, 2, 50, 65, 66]) {
      const input = { mode: 'content', query: { text: 'Needle' }, maxResults: limit };
      const found = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id, input } });
      assert.equal(found.isError, false, JSON.stringify(found));
      const result = searchReply.Parse(found.structuredContent);
      assert.equal(result.counts.matchingLines, Math.min(65, Math.max(0, limit)));
      assert.equal(result.limitHit, limit <= 65);
      observations.push({ input, result });
    }
    const inferred = searchReply.Parse((await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
      input: { query: { text: 'Needle' } } } })).structuredContent);
    assert.equal(inferred.counts.matchingLines, 50); assert.equal(inferred.limitHit, true);
    assert(inferred.files.some(file => file.path === 'Needle.swift' && file.pathMatch));
    const counted = searchReply.Parse((await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
      input: { query: { text: 'Needle' }, countOnly: true, maxResults: 2 } } })).structuredContent);
    assert.equal(counted.counts.matchingLines, 65); assert.equal(counted.limitHit, false); assert.deepEqual(counted.files, []);
    observations.push({ inferred, counted });
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/search-routing-public.json', JSON.stringify(observations, null, 2) + '\n');
  } finally { await client.close(); }
});
