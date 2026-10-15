import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { verifyBundle } from '../src/index.js';

const workspaceReply = Compile(Type.Object({ id: Type.String() }));
const draftReply = Compile(Type.Object({ id: Type.String(), revision: Type.Integer() }));
const metadataReply = Compile(Type.Object({ codemapMode: Type.String(), items: Type.Array(Type.Object({
  kind: Type.String(), id: Type.Optional(Type.String()), required: Type.Optional(Type.Boolean()),
})) }));
const readyReply = Compile(Type.Object({ kind: Type.Literal('ready'), directory: Type.String() }));

test('MCP admission retains mutable initial selection and manual mode separately from required evidence', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-initial-selection-')), root = join(base, 'repo'), output = join(base, 'out');
  await mkdir(root); await mkdir(output);
  await writeFile(join(root, 'seed.txt'), 'MUTABLE INITIAL EVIDENCE\n');
  await writeFile(join(root, 'required.txt'), 'REQUIRED EVIDENCE\n');
  const config = join(base, 'host.json');
  await writeFile(config, JSON.stringify({ cachePath: join(base, 'cache'), contextBudgetUnits: 200000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, git: null,
    discovery: null, defaultMaxOutputBytes: 100000 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'initial-selection', version: '1' }), proof: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = workspaceReply.Parse((await client.callTool({ name: 'workspace_declare', arguments: { spec: {
      roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [],
    } } })).structuredContent);
    for (const codemapMode of ['automatic', 'manual']) {
      const created = await client.callTool({ name: 'draft_create', arguments: { workspaceId: workspace.id, request: {
        task: 'Preserve the task', constraints: '', enhancementMode: 'preserve', purpose: 'review',
        duplicateUserInstructionsAtTop: false, copyPreset: 'standard', storedPrompts: [],
        initialSelection: { codemapMode, sources: [{ kind: 'full', source: { root: 'r', path: 'seed.txt' } }] },
        requiredSources: [{ kind: 'full', source: { root: 'r', path: 'required.txt' } }],
        documents: [], patches: [], discoveryHints: [], budgetUnits: 200000, outputName: codemapMode,
      } } });
      assert.equal(created.isError, false, JSON.stringify(created)); const draft = draftReply.Parse(created.structuredContent);
      const before = await client.callTool({ name: 'draft_inspect', arguments: { draftId: draft.id, input: { view: 'metadata', continuation: null } } });
      assert.equal(before.isError, false, JSON.stringify(before));
      const inspected = metadataReply.Parse(before.structuredContent); assert.equal(inspected.codemapMode, codemapMode);
      const seed = inspected.items.find(item => item.id === 'source:["r","seed.txt"]'); assert(seed); assert.equal(seed.required, false);
      assert.equal(inspected.items.find(item => item.id === 'source:["r","required.txt"]')?.required, true);
      const removed = await client.callTool({ name: 'manage_selection', arguments: { draftId: draft.id,
        input: { op: 'remove', paths: ['seed.txt'], expectedRevision: 0 } } });
      assert.equal(removed.isError, false, JSON.stringify(removed));
      const blocked = await client.callTool({ name: 'manage_selection', arguments: { draftId: draft.id,
        input: { op: 'remove', paths: ['required.txt'], expectedRevision: 1 } } }); assert.equal(blocked.isError, true);
      const finalized = await client.callTool({ name: 'draft_finalize', arguments: { draftId: draft.id } });
      assert.equal(finalized.isError, false, JSON.stringify(finalized)); const ready = readyReply.Parse(finalized.structuredContent);
      const verified = await verifyBundle(ready.directory), text = await readFile(join(ready.directory, 'context.md'), 'utf8');
      assert(text.includes('REQUIRED EVIDENCE')); assert(!text.includes('MUTABLE INITIAL EVIDENCE'));
      proof.push({ codemapMode, before, removed, blocked, directory: ready.directory, verified: verified.kind });
    }
    await writeFile('test-output/initial-selection-proof.json', JSON.stringify(proof, null, 2) + '\n');
  } finally { await client.close(); }
});
