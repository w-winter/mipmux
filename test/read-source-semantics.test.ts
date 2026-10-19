import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const argument = Type.Union([Type.Integer(), Type.String(), Type.Null()]);
const casesSchema = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Object({
  text: Type.String(), start_line: argument, offset: argument, limit: argument,
}), expected: Type.Union([
  Type.Object({ kind: Type.Literal('readTextSlice'), content: Type.String(), totalLines: Type.Integer(), firstLine: Type.Integer(),
    lastLine: Type.Integer(), returnedLineCount: Type.Integer(), message: Type.Union([Type.String(), Type.Null()]) }),
  Type.Object({ kind: Type.Literal('readTextRangeError'), code: Type.String(), message: Type.String() }),
]) })));
const declaration = Compile(Type.Object({ kind: Type.Literal('workspace'), id: Type.String() }));
const reply = Compile(Type.Union([
  Type.Object({ kind: Type.Literal('read'), content: Type.String(), totalLines: Type.Integer(), firstLine: Type.Integer(),
    lastLine: Type.Integer(), returnedLineCount: Type.Integer(), message: Type.Union([Type.String(), Type.Null()]) }),
  Type.Object({ kind: Type.Literal('error'), code: Type.String(), message: Type.String() }),
]));

test('public MCP read_file executes source bounds and retains exact text and diagnostic messages', async () => {
  const cases = casesSchema.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-read/cases.json'), 'utf8')));
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-read-source-'));
  const root = join(base, 'root'), out = join(base, 'out'); await mkdir(root); await mkdir(out);
  for (const [index, entry] of cases.entries()) await writeFile(join(root, index + '.txt'), '\uFEFF' + entry.input.text);
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(base, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], git: null, discovery: null,
    defaultMaxOutputBytes: 12000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'source-read', version: '1' });
  const proof: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = declaration.Parse((await client.callTool({ name: 'workspace_declare', arguments: {
      spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out },
    } })).structuredContent);
    for (const [index, entry] of cases.entries()) {
      const { start_line, offset, limit } = entry.input;
      const found = await client.callTool({ name: 'read_file', arguments: { workspaceId: workspace.id,
        input: { root: 'r', path: index + '.txt', start_line, offset, limit } } });
      assert.equal(found.isError, entry.expected.kind === 'readTextRangeError', entry.name + ': ' + JSON.stringify(found.structuredContent));
      const value = reply.Parse(found.structuredContent);
      if (entry.expected.kind === 'readTextRangeError') {
        assert.equal(found.isError, true); assert.equal(value.kind, 'error');
        if (value.kind !== 'error') assert.fail(entry.name);
        assert.equal(value.code, entry.expected.code); assert.equal(value.message, entry.expected.message);
      } else {
        assert.equal(found.isError, false); assert.equal(value.kind, 'read');
        if (value.kind !== 'read') assert.fail(entry.name);
        for (const field of ['content', 'totalLines', 'firstLine', 'lastLine', 'returnedLineCount', 'message'] as const) {
          assert.deepEqual(value[field], entry.expected[field], entry.name + ': ' + field);
        }
      }
      proof.push({ name: entry.name, result: found });
    }
    await writeFile(join(base, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n');
  } finally { await client.close(); }
});
