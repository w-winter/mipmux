import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { MipmuxRuntime } from '../src/runtime/mipmux-runtime.js';
import { searchValidator } from '../src/contracts/exploration.js';
import type { ProcessSpec } from '../src/runtime/process-supervisor.js';
import { toolJSON } from './fixtures/tool-json.js';

const workspaceReply = Compile(Type.Object({ id: Type.String() }));
const searchReply = Compile(Type.Object({ kind: Type.Literal('search'), scopedFileCount: Type.Integer(),
  files: Type.Array(Type.Object({ root: Type.String(), path: Type.String() })) }));
const errorReply = Compile(Type.Object({ kind: Type.Literal('error'), code: Type.String(), message: Type.String() }));

test('public raw scopes use RPCE clauses and preserve protected paths and ambiguity diagnostics', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-public-scopes-'));
  const a = join(base, 'a'), b = join(base, 'b'), out = join(base, 'out');
  await mkdir(a); await mkdir(b); await mkdir(out);
  for (const [root, paths] of [[a, ['src/a.ts', 'src/nested/b.ts', 'srcish/c.ts', 'shared.ts', 'protected.txt']],
    [b, ['src/other.ts', 'shared.ts']]] as const) for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), 'needle\n');
  }
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(base, 'cache'), nativeEnvironment: {},
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [join(a, 'protected.txt')],
    git: null, discovery: null, defaultMaxOutputBytes: 100000 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--tools', 'full', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'source-raw-scopes', version: '1' });
  const observations: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = workspaceReply.Parse(toolJSON(await client.callTool({ name: 'workspace_declare', arguments: {
      spec: { roots: [{ name: 'Alpha', absolutePath: a }, { name: 'Beta', absolutePath: b }], exclusions: [], outputRoot: out },
    } })));
    const cases = [
      { paths: ['Alpha/src/a.ts'], expected: ['Alpha/src/a.ts'] },
      { paths: ['Alpha/src'], expected: ['Alpha/src/a.ts', 'Alpha/src/nested/b.ts'] },
      { paths: [join(a, 'src')], expected: ['Alpha/src/a.ts', 'Alpha/src/nested/b.ts'] },
      { paths: ['ALPHA/src/*.ts'], expected: ['Alpha/src/a.ts', 'Alpha/src/nested/b.ts'] },
      { paths: [join(a, 'src/*.ts')], expected: ['Alpha/src/a.ts', 'Alpha/src/nested/b.ts'] },
      { paths: ['Alpha/src/a.ts', 'Alpha/src'], expected: ['Alpha/src/a.ts', 'Alpha/src/nested/b.ts'] },
      { paths: ['shared.ts', 'Alpha/src/a.ts'], expected: ['Alpha/src/a.ts'] },
      { paths: ['Alpha/protected.txt'], expected: [] },
      { paths: ['unrelated-missing-9375'], expected: [] },
      { paths: ['  '], expected: [] },
    ];
    for (const item of cases) {
      const found = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
        input: { mode: 'content', query: { text: 'needle' }, filters: { paths: item.paths } } } });
      assert.equal(found.isError, false, JSON.stringify(found));
      const result = searchReply.Parse(toolJSON(found));
      assert.deepEqual(result.files.map(file => file.root + '/' + file.path), item.expected, JSON.stringify(item));
      assert.equal(result.scopedFileCount, item.expected.length);
      observations.push({ item, result });
    }
    const ambiguous = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
      input: { query: { text: 'needle' }, filters: { paths: ['shared.ts'] } } } });
    assert.equal(ambiguous.isError, true);
    assert.match(errorReply.Parse(toolJSON(ambiguous)).message, /matches multiple workspace roots/);
    observations.push({ ambiguous });
    await writeFile(join(a, 'added.ts'), 'needle\n');
    const added = await client.callTool({ name: 'file_search', arguments: { workspaceId: workspace.id,
      input: { mode: 'content', query: { text: 'needle' }, filters: { paths: ['added.ts'] } } } });
    assert.equal(added.isError, false, JSON.stringify(added));
    assert.deepEqual(searchReply.Parse(toolJSON(added)).files.map(file => file.path), ['added.ts']);
    observations.push({ added });
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/search-scopes-public.json', JSON.stringify(observations, null, 2) + '\n');
  } finally { await client.close(); }
});

for (const boundary of ['catalog', 'body'] as const) test(`search handles disappearance during ${boundary} acquisition`, async t => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-scope-refresh-'));
  const root = join(base, 'root'), out = join(base, 'out'); await mkdir(root); await mkdir(out);
  await writeFile(join(root, 'victim.ts'), 'needle\n');
  const healthy = join(base, 'healthy'); await mkdir(healthy); await writeFile(join(healthy, 'safe.ts'), 'needle\n');
  const nativeExecutable = resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`);
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), nativeExecutable, nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [] });
  const spawn = runtime.supervisor.spawn.bind(runtime.supervisor);
  let entered!: () => void;
  const holding = new Promise<void>(resolve => { entered = resolve; });
  const arm = join(base, 'arm'), release = join(base, 'release');
  t.mock.method(runtime.supervisor, 'spawn', (spec: ProcessSpec) => {
    if (spec.executable !== nativeExecutable) return spawn(spec);
    const owned = spawn({ ...spec, executable: process.execPath,
      args: [resolve('test/fixtures/search-freshness-proxy.mjs'), ...spec.args],
      env: { ...spec.env, MIPMUX_NATIVE: nativeExecutable, MIPMUX_SCOPE_ARM: arm, MIPMUX_SCOPE_RELEASE: release,
        MIPMUX_SCOPE_BOUNDARY: boundary } });
    let stderr = '';
    owned.child.stderr.on('data', bytes => { stderr += bytes.toString(); if (stderr.includes('MIPMUX_SCOPE_FRESHNESS_HELD')) entered(); });
    return owned;
  });
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }, { name: 's', absolutePath: healthy }],
      exclusions: [], outputRoot: out }, new AbortController().signal);
    await workspace.refresh(new AbortController().signal);
    const operation = await workspace.openOperation(new AbortController().signal);
    try {
      await writeFile(arm, '');
      const result = operation.fileSearch(searchValidator.Parse({ mode: 'content', query: { kind: 'literal', text: 'needle',
        caseSensitive: true, wholeWord: false }, filters: { roots: [], paths: boundary === 'catalog' ? ['victim.ts'] : ['*.ts'], exclude: [], extensions: [] },
      before: 0, after: 0, maxResults: 50, countOnly: false, maxOutputBytes: 100000, continuation: null }));
      await holding;
      if (boundary === 'catalog') await rename(join(root, 'victim.ts'), join(base, 'retired.ts'));
      else await rename(root, join(base, 'retired-root'));
      await writeFile(release, '');
      const found = await result;
      if (found.kind !== 'search') assert.fail('Missing search result');
      if (boundary === 'catalog') {
        assert.deepEqual(found.files, []); assert.equal(found.counts.matchingLines, 0);
      } else {
        assert.deepEqual(found.files.map(file => file.root + '/' + file.path), ['s/safe.ts']);
        assert.deepEqual(found.limitations, [{ root: 'r', path: 'victim.ts', code: 'rootChanged' }]);
      }
      await mkdir('test-output', { recursive: true });
      await writeFile(`test-output/search-scope-disappearance-${boundary}.json`, JSON.stringify(found, null, 2) + '\n');
    } finally { await operation.close(); }
    await workspace.close();
  } finally { await runtime.close(); }
});

test('fresh searches retain healthy roots when another registered root is replaced', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-scope-roots-'));
  const a = join(base, 'a'), b = join(base, 'b'), out = join(base, 'out');
  await mkdir(a); await mkdir(b); await mkdir(out);
  await writeFile(join(a, 'healthy.txt'), 'needle\n');
  await writeFile(join(b, '.repo_ignore'), 'hidden.txt\n'); await writeFile(join(b, 'hidden.txt'), 'needle\n');
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), nativeEnvironment: {},
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [] });
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'a', absolutePath: a }, { name: 'b', absolutePath: b }],
      exclusions: [], outputRoot: out }, new AbortController().signal);
    await workspace.refresh(new AbortController().signal);
    const operation = await workspace.openOperation(new AbortController().signal);
    try {
      await operation.registerExplicitSource({ root: 'b', path: 'hidden.txt' });
      await rename(b, join(base, 'retired')); await mkdir(b); await writeFile(join(b, 'replacement.txt'), 'needle replacement\n');
      const found = await operation.fileSearch(searchValidator.Parse({ mode: 'content', query: { kind: 'literal', text: 'needle',
        caseSensitive: true, wholeWord: false }, filters: { roots: [], paths: [], exclude: [], extensions: [] },
      before: 0, after: 0, maxResults: 50, countOnly: false, maxOutputBytes: 100000, continuation: null }));
      const partial = Compile(Type.Object({ files: Type.Array(Type.Object({ root: Type.String(), path: Type.String() })),
        unavailableRoots: Type.Array(Type.Object({ root: Type.String(), code: Type.String() })) })).Parse(found);
      assert.deepEqual(partial.files.map(file => file.root + '/' + file.path), ['a/healthy.txt']);
      assert.deepEqual(partial.unavailableRoots, [{ root: 'b', code: 'rootChanged' }]);
      await mkdir('test-output', { recursive: true });
      await writeFile('test-output/search-scope-root-identity.json', JSON.stringify(found, null, 2) + '\n');
    } finally { await operation.close(); }
    await workspace.close();
  } finally { await runtime.close(); }
});
