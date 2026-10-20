import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const identifier = Compile(Type.Object({ id: Type.String() }));
const revision = Compile(Type.Object({ revision: Type.Integer() }));
const listing = Compile(Type.Object({ op: Type.Literal('list_presets'), presets_list: Type.Object({ presets: Type.Array(Type.Unknown()) }) }));
const exportedReply = Compile(Type.Object({ op: Type.Literal('export'), export: Type.Object({ bytes: Type.Integer(), tokens: Type.Integer(), files: Type.Array(Type.Unknown()) }) }));
const finalized = Compile(Type.Object({ kind: Type.Literal('ready'), directory: Type.String() }));
const removedPlanID = '11111111-1111-1111-1111-111111111111';

test('real MCP lists presets before draft lookup and exports a nonterminal captured context', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-prompt-export-'));
  const root = join(base, 'source'), output = join(base, 'output'), config = join(base, 'host.json');
  await mkdir(root); await mkdir(output);
  await writeFile(join(root, 'source.txt'), 'EXACT SOURCE λ\n');
  const custom = { id: '77777777-7777-7777-7777-777777777777', name: 'Captured custom', builtInKind: null,
    isBuiltIn: false, description: null, icon: null, notes: null,
    includeFiles: true, includeUserPrompt: false, includeFileTree: false,
    fileTreeMode: null, codeMapUsage: null, gitInclusion: null };
  const copyContext = { current: { fileTreeMode: 'None', codeMapUsage: 'none', gitInclusion: 'none' },
    customizations: { includeFiles: null, includeUserPrompt: false, includeFileTree: false,
      fileTreeMode: null, codeMapUsage: 'complete', gitInclusion: null },
    codeMapsGloballyDisabled: false, activeGitRoot: null, presets: [{ ...custom,
      id: '00000000-0000-0000-0000-000000000000', name: 'Ignored override name', builtInKind: 'standard', isBuiltIn: true,
      includeFiles: false, includeUserPrompt: true }, custom] };
  await writeFile(config, JSON.stringify({ cachePath: join(base, 'cache'), contextBudgetUnits: 200000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    credentialPaths: [], terminationGraceMs: 100, git: null, discovery: null, defaultMaxOutputBytes: 20000, copyContext }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'prompt-export', version: '1' });
  const evidence: unknown[] = [];
  async function call(name: string, args: NonNullable<Parameters<Client['callTool']>[0]['arguments']>) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert(result.structuredContent);
    evidence.push({ name, result: result.structuredContent });
    return result.structuredContent;
  }
  try {
    await client.connect(transport);
    const list = listing.Parse(await call('prompt', { input: { op: 'list_presets' } }));
    assert.equal(list.presets_list.presets.length, 5);
    assert.deepEqual(list.presets_list.presets[4], { preset: { id: custom.id, name: custom.name, is_built_in: false },
      include_files: true, include_user_prompt: false, include_file_tree: false });
    assert.deepEqual(list.presets_list.presets[3], { preset: { id: '22222222-2222-2222-2222-222222222222', name: 'Manual',
      kind: 'manual', is_built_in: true }, description: 'Full control - use current settings', icon: '⚙️' });
    const declared = identifier.Parse(await call('workspace_declare', { spec: { roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] } }));
    const created = identifier.Parse(await call('draft_create', { workspaceId: declared.id, request: { task: 'ORIGINAL TASK', constraints: '',
      purpose: 'investigation', enhancementMode: 'preserve', initialSelection: { codemapMode: 'manual',
        sources: [{ kind: 'full', source: { root: 'r', path: 'source.txt' } }] }, requiredSources: [], documents: [], patches: [],
      duplicateUserInstructionsAtTop: false, copyPreset: 'standard', budgetUnits: 100000,
      discoveryHints: [], outputName: 'final-packet' } }));
    const draftId = created.id;
    const before = await call('draft_inspect', { draftId, input: { view: 'metadata', continuation: null } });
    for (const { path, copy_preset } of [
      { path: 'unrecognized-preset-kind.md', copy_preset: { kind: 'unregistered' } },
      { path: 'removed-plan-kind.md', copy_preset: { kind: 'plan' } },
      { path: 'removed-plan-name.md', copy_preset: { name: 'Plan' } },
      { path: 'removed-plan-id.md', copy_preset: removedPlanID },
    ]) {
      const failure = await client.callTool({ name: 'prompt', arguments: { draftId, input: { op: 'export', path, copy_preset } } });
      assert.equal(failure.isError, true, JSON.stringify(failure));
      assert.match(JSON.stringify(failure), /copyPresetNotFound/);
      await assert.rejects(readFile(join(output, path)), /ENOENT/);
      assert.deepEqual(await call('draft_inspect', { draftId, input: { view: 'metadata', continuation: null } }), before);
    }
    const exported = exportedReply.Parse(await call('prompt', { draftId, input: { op: 'export', path: 'interim.md', copy_preset: 'manual' } }));
    const text = await readFile(join(output, 'interim.md'), 'utf8');
    assert.equal(text, '<file_contents>\nFile: r/source.txt\n```txt\nEXACT SOURCE λ\n\n```\n</file_contents>\n');
    assert.equal(exported.export.bytes, Buffer.byteLength(text));
    assert.equal(exported.export.tokens, Math.floor(Buffer.byteLength(text) * 21 / 80));
    assert.deepEqual(exported.export.files, [{ path: 'source.txt', tokens: 4, render_mode: 'full', is_auto: false,
      root_path: 'r', path_within_root: 'source.txt' }]);
    const after = await call('draft_inspect', { draftId, input: { view: 'metadata', continuation: null } });
    assert.deepEqual(after, before);
    const customExport = await call('prompt', { draftId, input: { op: 'export', path: 'custom.md', copy_preset: { name: 'Captured custom' } } });
    assert.equal(await readFile(join(output, 'custom.md'), 'utf8'), text); assert(customExport);
    await call('prompt', { draftId, input: { op: 'export', path: join(output, 'absolute.md'), copy_preset: 'manual' } });
    assert.equal(await readFile(join(output, 'absolute.md'), 'utf8'), text);
    for (const { path, copy_preset } of [{ path: 'id.md', copy_preset: '00000000-0000-0000-0000-000000000000' },
      { path: 'name.md', copy_preset: { name: 'Standard' } }]) {
      await call('prompt', { draftId, input: { op: 'export', path, copy_preset } });
      assert.equal(await readFile(join(output, path), 'utf8'),
        '<user_instructions>\nORIGINAL TASK\n</user_instructions>\n');
    }
    const unresolved = await client.callTool({ name: 'prompt', arguments: { draftId, input: { op: 'export', path: 'missing.md',
      copy_preset: { id: '99999999-9999-9999-9999-999999999999', kind: 'standard', name: 'Standard' } } } });
    assert.equal(unresolved.isError, true); await assert.rejects(readFile(join(output, 'missing.md')), /ENOENT/);
    await symlink(join(root, 'source.txt'), join(output, 'leaf.md'));
    for (const path of ['interim.md', '../escape.md', join(root, 'unauthorized.md'), 'link/escape.md', 'leaf.md']) {
      if (path === 'link/escape.md') await symlink(root, join(output, 'link'));
      const failure = await client.callTool({ name: 'prompt', arguments: { draftId, input: { op: 'export', path } } });
      assert.equal(failure.isError, true, path);
    }
    assert.equal(await readFile(join(output, 'interim.md'), 'utf8'), text);
    assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'EXACT SOURCE λ\n');
    const collision = await Promise.all([1, 2].map(() => client.callTool({ name: 'prompt', arguments: { draftId, input: { op: 'export', path: 'collision.md' } } })));
    assert.equal(collision.filter(reply => !reply.isError).length, 1);
    const mutation = revision.Parse(await call('prompt', { draftId, input: { op: 'append', text: '\nCONTINUED', expectedRevision: 0 } }));
    assert.equal(mutation.revision, 1);
    const final = finalized.Parse(await call('draft_finalize', { draftId }));
    assert((await readFile(join(final.directory, 'context.md'), 'utf8')).includes('CONTINUED'));
    assert.equal(await readFile(join(output, 'interim.md'), 'utf8'), text);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/prompt-export-mcp.json', JSON.stringify({ base, evidence }, null, 2) + '\n');
  } finally { await client.close(); }
});
