import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { StructureToolResult } from '../src/contracts/structure.js';

const identifier = Compile(Type.Object({ id: Type.String() }));
const graph = Compile(StructureToolResult);

test('public structural seeds use owned selection, whole roots, direct-file priority and source absence diagnostics', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-structure-seeds-'));
  const root = join(base, 'source'), output = join(base, 'out'), config = join(base, 'host.json');
  await mkdir(join(root, 'src'), { recursive: true }); await mkdir(join(root, 'empty')); await mkdir(output);
  for (const name of ['A', 'B']) await writeFile(join(root, 'src', `${name}.swift`),
    `struct ${name}Record {\n let shared: SharedRecord\n}\n`);
  await writeFile(join(root, 'src', 'Shared.swift'), 'struct SharedRecord {\n let value: Int\n}\n');
  await writeFile(join(root, 'readme.txt'), 'Source fixture\n');
  await writeFile(config, JSON.stringify({ cachePath: join(base, 'cache'), contextBudgetUnits: 1000000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, credentialPaths: [], git: null, discovery: null, defaultMaxOutputBytes: 50000 }));
  const client = new Client({ name: 'structure-seeds', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  try {
    await client.connect(transport);
    const spec = { roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] };
    const workspaceId = identifier.Parse((await client.callTool({ name: 'workspace_declare', arguments: { spec } })).structuredContent).id;
    const blankReply = await client.callTool({ name: 'get_code_structure', arguments: { workspaceId } });
    assert.equal(blankReply.isError, false, JSON.stringify(blankReply));
    const blank = graph.Parse(blankReply.structuredContent);
    assert.equal(blank.status, 'unavailable'); assert.equal(blank.issues[0]?.code, 'path_not_found');
    const draftId = identifier.Parse((await client.callTool({ name: 'draft_create', arguments: { workspaceId, request: {
      task: 'Inspect fixture structure.', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      requiredSources: [{ kind: 'full', source: { root: 'r', path: 'src/A.swift' } },
        { kind: 'slices', source: { root: 'r', path: 'src/B.swift' }, ranges: [{ start: 1, end: 1, description: 'Declaration' }] }],
      documents: [], patches: [], discoveryHints: [], outputName: 'selected-structure',
      budgetUnits: 100000,
    } } })).structuredContent).id;
    const selectedReply = await client.callTool({ name: 'get_code_structure', arguments: {
      workspaceId, draftId, input: { expand: 'uses', signatures: false } } });
    assert.equal(selectedReply.isError, false, JSON.stringify(selectedReply));
    const selected = graph.Parse(selectedReply.structuredContent);
    assert.deepEqual(selected.roots[0]?.seeds.map(seed => seed.path), ['r/src/A.swift', 'r/src/B.swift']);
    assert.equal(selected.summary.nodes, 3); assert.equal(selected.summary.edges, 2);
    const whole = graph.Parse((await client.callTool({ name: 'get_code_structure', arguments: { workspaceId, input: {
      seeds: [{ kind: 'directory', root: 'r', directory: { kind: 'root' } }], signatures: false } } })).structuredContent);
    assert.equal(whole.summary.seeds, 4);
    const mixed = graph.Parse((await client.callTool({ name: 'get_code_structure', arguments: { workspaceId, input: {
      seeds: [{ kind: 'file', root: 'r', path: 'missing.swift' }, { kind: 'file', root: 'r', path: 'src/A.swift' },
        { kind: 'directory', root: 'r', directory: { kind: 'descendant', path: 'src' } }], signatures: false } } })).structuredContent);
    assert.equal(mixed.summary.seeds, 3);
    for (const seed of [
      { kind: 'file', root: 'r', path: 'missing.swift' },
      { kind: 'directory', root: 'r', directory: { kind: 'descendant', path: 'empty' } },
    ]) {
      const missingReply = await client.callTool({ name: 'get_code_structure', arguments: { workspaceId, input: { seeds: [seed] } } });
      assert.equal(missingReply.isError, false);
      const missing = graph.Parse(missingReply.structuredContent);
      assert.equal(missing.status, 'unavailable'); assert.equal(missing.issues[0]?.code, 'path_not_found');
    }
    const tooMany = await client.callTool({ name: 'get_code_structure', arguments: { workspaceId, input: {
      seeds: Array.from({ length: 257 }, () => ({ kind: 'file', root: 'r', path: 'src/A.swift' })) } } });
    assert.equal(tooMany.isError, true);
    const foreign = await client.callTool({ name: 'get_code_structure', arguments: { workspaceId, draftId: 'foreign' } });
    assert.equal(foreign.isError, true);
    await writeFile(join(base, 'structure-seeds-proof.json'), JSON.stringify({ blank, selected, whole, mixed }, null, 2) + '\n');
  } finally { await client.close(); }
});
