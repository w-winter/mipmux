import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { verifyBundle } from '../src/index.js';

const draftReply = Compile(Type.Object({ id: Type.String(), revision: Type.Integer() }));
const workspaceReply = Compile(Type.Object({ id: Type.String() }));
const readyReply = Compile(Type.Object({ kind: Type.Literal('ready'), directory: Type.String() }));
const promptReply = Compile(Type.Object({ prompt: Type.String(), revision: Type.Integer() }));
const original = 'ORIGINAL TASK 🙂\r\nKeep these exact bytes.\n';
const rewritten = '<task>Rewritten from discoveries</task>\n<architecture>One source</architecture>';
const appended = '\n\n<discovered_architecture>One source</discovered_architecture>';
type PromptToolInput = { op: 'get' } | { op: 'set' | 'append'; text: string; expectedRevision: number } |
  { op: 'clear'; expectedRevision: number };

test('public MCP literal prompt operations publish Rewrite, Augment and unchanged Preserve without an advisory handoff', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-prompt-state-'));
  const root = join(base, 'source'), output = join(base, 'out'), config = join(base, 'host.json');
  await mkdir(root); await mkdir(output);
  await writeFile(join(root, 'source.txt'), 'EXACT SOURCE\n');
  await writeFile(config, JSON.stringify({ cachePath: join(base, 'cache'), contextBudgetUnits: 1000000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, search: null, git: null,
    discovery: null, defaultMaxOutputBytes: 10000 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  const client = new Client({ name: 'prompt-state', version: '1' });
  const evidence: { mode: string; directory: string; prompt: string; units: number }[] = [];
  try {
    await client.connect(transport);
    const declaration = await client.callTool({ name: 'workspace_declare', arguments: { spec: {
      roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] } } });
    assert.equal(declaration.isError, false);
    const workspaceId = workspaceReply.Parse(declaration.structuredContent).id;
    for (const mode of ['fullRewrite', 'augment', 'preserve']) {
      const created = await client.callTool({ name: 'draft_create', arguments: { workspaceId, request: {
        task: original, constraints: '', purpose: 'investigation', enhancementMode: mode,
        requiredSources: [{ kind: 'full', source: { root: 'r', path: 'source.txt' } }],
        documents: [], patches: [], discoveryHints: [], outputName: mode,
        budgetUnits: 100000 } } });
      assert.equal(created.isError, false, JSON.stringify(created));
      const draft = draftReply.Parse(created.structuredContent);
      const get = () => client.callTool({ name: 'prompt', arguments: { draftId: draft.id, input: { op: 'get' } } });
      assert.equal(promptReply.Parse((await get()).structuredContent).prompt, original);
      const expected = mode === 'fullRewrite' ? rewritten : mode === 'augment' ? original + appended : original;
      if (mode !== 'preserve') {
        const result = await client.callTool({ name: 'prompt', arguments: { draftId: draft.id,
          input: { op: mode === 'augment' ? 'append' : 'set', text: mode === 'augment' ? appended : rewritten,
            expectedRevision: 0 } } });
        assert.equal(result.isError, false, JSON.stringify(result));
        const changed = promptReply.Parse(result.structuredContent);
        assert.equal(changed.prompt, expected); assert.equal(changed.revision, 1);
      }
      const finalized = await client.callTool({ name: 'draft_finalize', arguments: { draftId: draft.id } });
      assert.equal(finalized.isError, false, JSON.stringify(finalized));
      const ready = readyReply.Parse(finalized.structuredContent);
      const { manifest } = await verifyBundle(ready.directory);
      const packet = await readFile(join(ready.directory, 'context.md'), 'utf8');
      assert(packet.endsWith('<user_instructions>\n' + expected + '\n</user_instructions>\n'));
      assert(!packet.includes('Discovery clarification (advisory)'));
      assert.equal(packet.includes(original), mode !== 'fullRewrite');
      assert(packet.includes('EXACT SOURCE\n'));
      assert.equal(manifest.accounting.units, Number(21n * BigInt(Buffer.byteLength(packet)) / 80n));
      evidence.push({ mode, directory: ready.directory, prompt: expected, units: manifest.accounting.units });
    }
    const created = await client.callTool({ name: 'draft_create', arguments: { workspaceId, request: {
      task: original, constraints: '', purpose: 'investigation', enhancementMode: 'augment', requiredSources: [],
      documents: [], patches: [], discoveryHints: [], outputName: 'operations',
      budgetUnits: 100000 } } });
    const draft = draftReply.Parse(created.structuredContent);
    const invoke = (input: PromptToolInput, maxOutputBytes = 10000) => client.callTool({ name: 'prompt',
      arguments: { draftId: draft.id, input, maxOutputBytes } });
    const invalidInputs: PromptToolInput[] = [{ op: 'set', text: '\ud800', expectedRevision: 0 },
      { op: 'append', text: 'NUL\0', expectedRevision: 0 }];
    for (const input of invalidInputs) {
      const rejected = await invoke(input); assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected.structuredContent), /invalidEncoding/);
    }
    assert.equal((await invoke({ op: 'set', text: 'Too large', expectedRevision: 0 }, 1)).isError, true);
    assert.equal(promptReply.Parse((await invoke({ op: 'get' })).structuredContent).prompt, original);
    const noOp = promptReply.Parse((await invoke({ op: 'set', text: original, expectedRevision: 0 })).structuredContent);
    assert.equal(noOp.revision, 0);
    const cleared = promptReply.Parse((await invoke({ op: 'clear', expectedRevision: 0 })).structuredContent);
    assert.equal(cleared.prompt, ''); assert.equal(cleared.revision, 1);
    const stale = await invoke({ op: 'append', text: appended, expectedRevision: 0 });
    assert.equal(stale.isError, true); assert.match(JSON.stringify(stale.structuredContent), /revisionConflict/);
    const replaced = promptReply.Parse((await invoke({ op: 'set', text: original + appended, expectedRevision: 1 })).structuredContent);
    assert.equal(replaced.prompt, original + appended); assert.equal(replaced.revision, 2);
    await writeFile(join(base, 'prompt-state-proof.json'), JSON.stringify({ evidence, cleared, replaced }, null, 2) + '\n');
  } finally { await client.close(); }
});
