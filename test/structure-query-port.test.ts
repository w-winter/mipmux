import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const identifier = Compile(Type.Object({ id: Type.String() }));
const graphReply = Compile(Type.Object({ status: Type.String(), size: Type.String(),
  roots: Type.Array(Type.Object({ root: Type.String(),
    nodes: Type.Array(Type.Object({ path: Type.String(), depth: Type.Integer() })),
    edges: Type.Array(Type.Object({ from: Type.String(), to: Type.String(), symbols: Type.Array(Type.String()) })),
    unresolved: Type.Array(Type.Object({ from: Type.String(), name: Type.String(), reason: Type.String() })),
  })),
  files: Type.Array(Type.Unknown()), summary: Type.Object({ seeds: Type.Integer(), nodes: Type.Integer(),
    edges: Type.Integer(), files: Type.Integer(), tokens: Type.Integer() }),
}));

test('public structural query exposes source graph evidence with signatures disabled and the requested output size', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-structure-query-port-'));
  const root = join(base, 'source'), output = join(base, 'out'), config = join(base, 'host.json');
  await mkdir(root); await mkdir(output);
  for (const name of ['A', 'B']) await writeFile(join(root, `${name}.swift`),
    `struct ${name}Record {\n let shared: SharedRecord\n let missing: MissingRecord\n}\n`);
  await writeFile(join(root, 'Shared.swift'), 'struct SharedRecord {\n let value: Int\n}\n');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 1000000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, credentialPaths: [], git: null, discovery: null, defaultMaxOutputBytes: 30000 }));
  const client = new Client({ name: 'structure-query-port', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  try {
    await client.connect(transport);
    const workspaceId = identifier.Parse((await client.callTool({ name: 'workspace_declare', arguments: { spec: {
      roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] } } })).structuredContent).id;
    const result = await client.callTool({ name: 'get_code_structure', arguments: { workspaceId, input: {
      seeds: [{ root: 'r', path: 'A.swift', kind: 'file' }, { root: 'r', path: 'B.swift', kind: 'file' }],
      expand: 'uses', depth: 1, signatures: false, size: 'small' } } });
    assert.equal(result.isError, false, JSON.stringify(result));
    const delivered = result.content.find(item => item.type === 'text');
    assert(delivered?.type === 'text');
    assert(delivered.text.startsWith('## Code Structure ✅'));
    assert(delivered.text.includes('`A.swift` (seed) → uses:'));
    const graph = graphReply.Parse(result.structuredContent);
    assert.equal(graph.status, 'ok'); assert.equal(graph.size, 'small'); assert.deepEqual(graph.files, []);
    assert.deepEqual(graph.summary, { seeds: 2, nodes: 3, edges: 2, files: 0, tokens: 0 });
    const selectedRoot = graph.roots[0]; assert(selectedRoot);
    assert.equal(selectedRoot.root, 'r');
    assert.deepEqual(selectedRoot.edges, [
      { from: 'r/A.swift', to: 'r/Shared.swift', symbols: ['SharedRecord'] },
      { from: 'r/B.swift', to: 'r/Shared.swift', symbols: ['SharedRecord'] },
    ]);
    assert.deepEqual(selectedRoot.unresolved, [
      { from: 'r/A.swift', name: 'MissingRecord', reason: 'missing' },
      { from: 'r/B.swift', name: 'MissingRecord', reason: 'missing' },
    ]);
    await writeFile(join(base, 'structure-query-proof.json'), JSON.stringify(graph, null, 2) + '\n');
  } finally { await client.close(); }
});
