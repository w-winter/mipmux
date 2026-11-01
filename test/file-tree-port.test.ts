import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { MipmuxRuntime } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { toolJSON } from './fixtures/tool-json.js';
import { fixtureSettings } from './fixtures/discovery-settings.js';

const identifier = Compile(Type.Object({ id: Type.String() }));
const treeReply = Compile(Type.Object({ kind: Type.Literal('tree'), tree: Type.String(), rootsCount: Type.Integer() }));
interface HeldRender { active: BridgeClient | null }
interface HeldStartupRender { signal: AbortSignal | null }

test('public MCP tree uses RPCE folder depth, scoped roots, available-codemap markers and selected descendants', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mipmux-file-tree-port-')));
  const root = join(base, 'r'), other = join(base, 's'), output = join(base, 'out'), config = join(base, 'host.json');
  await mkdir(join(root, 'zone/child'), { recursive: true });
  await mkdir(join(other, 'zone'), { recursive: true }); await mkdir(output);
  await writeFile(join(root, 'zone/direct.txt'), 'Direct\n');
  await writeFile(join(root, 'zone/child/deep.txt'), 'Selected descendant\n');
  await writeFile(join(root, 'zone/Shared.swift'), 'struct SharedRecord {\n let value: Int\n}\n');
  await writeFile(join(root, 'outside.txt'), 'Outside\n');
  await writeFile(join(other, 'zone/wrong-root.txt'), 'Other root\n');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 1000000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, terminationGraceMs: 100, credentialPaths: [], git: null,
    discovery: null, defaultMaxOutputBytes: 12000 }));
  const client = new Client({ name: 'tree-port', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--tools', 'full', '--config', config], cwd: '/', stderr: 'pipe' });
  try {
    await client.connect(transport);
    const declaration = await client.callTool({ name: 'workspace_declare', arguments: { spec: {
      roots: [{ name: 'alpha', absolutePath: root }, { name: 'beta', absolutePath: other }], exclusions: [], outputRoot: output } } });
    const workspaceId = identifier.Parse(toolJSON(declaration)).id;
    const scope = { root: 'alpha', directory: { kind: 'descendant', path: 'zone' } };
    const full = await client.callTool({ name: 'get_file_tree', arguments: { workspaceId,
      input: { type: 'files', mode: 'full', scope, maxDepth: 0 } } });
    assert.equal(full.isError, false, JSON.stringify(full));
    const fullTree = treeReply.Parse(toolJSON(full));
    assert.equal(fullTree.rootsCount, 1);
    assert.equal(fullTree.tree, 'alpha/zone\n├── child\n│   └── ...\n├── Shared.swift +\n└── direct.txt\n');
    const roots = treeReply.Parse(toolJSON(await client.callTool({ name: 'get_file_tree', arguments: { workspaceId,
      input: { type: 'roots' } } })));
    assert.equal(roots.tree, root + '\n' + other); assert.equal(roots.rootsCount, 2);
    const draft = identifier.Parse(toolJSON(await client.callTool({ name: 'draft_create', arguments: { workspaceId, request: {
      task: 'Keep the selected source', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      requiredSources: [{ kind: 'full', source: { root: 'alpha', path: 'zone/child/deep.txt' } }],
      documents: [], patches: [], discoveryHints: [], outputName: 'packet',
      budgetUnits: 100000 } } })));
    const selected = treeReply.Parse(toolJSON(await client.callTool({ name: 'get_file_tree', arguments: { workspaceId,
      draftId: draft.id, input: { type: 'files', mode: 'selected', scope, maxDepth: 0 } } })));
    assert.equal(selected.tree, 'alpha/zone\n└── child\n    └── deep.txt *\n');
    assert.equal(selected.rootsCount, 1);
    const folders = treeReply.Parse(toolJSON(await client.callTool({ name: 'get_file_tree', arguments: { workspaceId,
      input: { type: 'files', mode: 'folders', scope } } })));
    assert.equal(folders.tree, 'alpha/zone\n└── child\n');
    await writeFile(join(base, 'file-tree-port-proof.json'), JSON.stringify({ fullTree, roots, selected, folders }, null, 2) + '\n');
  } finally { await client.close(); }
});

for (const nativeKind of ['renderFileTree', 'queryStructure'] as const) test(`closing a workspace operation joins its admitted ${nativeKind} work and leaves a sibling usable`, async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-tree-close-'));
  const root = join(base, 'source'), output = join(base, 'out');
  await mkdir(root); await mkdir(output); await writeFile(join(root, 'file.txt'), 'Source\n');
  let entered!: () => void, release!: () => void, hold = true;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const state: HeldRender = { active: null };
  class Runtime extends MipmuxRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (hold && operation.kind === nativeKind) {
            hold = false; state.active = this; entered(); await held;
          }
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 1000000,
    credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {} });
  const signal = new AbortController().signal;
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, signal);
    const operation = await workspace.openOperation(signal), sibling = await workspace.openOperation(signal);
    const request = { type: 'files' as const, mode: 'full' as const, scope: null, maxDepth: null, selection: null,
      continuation: null, maxOutputBytes: 12000 };
    const query = { seeds: [{ root: 'r', path: 'file.txt', kind: 'file' as const }], expand: 'none' as const, depth: 1,
      signatures: false, size: 'medium' as const, maxOutputBytes: 12000, selection: null };
    const work = nativeKind === 'renderFileTree' ? operation.getFileTree(request) : operation.getCodeStructure(query);
    const rejected = assert.rejects(work, /aborted|cancelled|nativeWorkerClosed/i);
    await entering; assert(state.active);
    let finished = false;
    const closing = operation.close().then(() => { finished = true; });
    await state.active.closed; assert.equal(finished, false);
    release(); await rejected; await closing;
    const other = nativeKind === 'renderFileTree' ? await sibling.getFileTree(request) : await sibling.getCodeStructure(query);
    if (nativeKind === 'renderFileTree') { assert(other.kind === 'tree'); assert(other.tree.includes('file.txt')); }
    else { assert(other.kind === 'structure'); assert.equal(other.roots[0]?.seeds[0]?.path, 'r/file.txt'); }
    await writeFile(join(base, nativeKind + '-close-proof.json'), JSON.stringify({ finished, sibling: other }, null, 2) + '\n');
    await sibling.close(); await workspace.close();
  } finally { release(); await runtime.close(); }
});

test('job cancellation reaches a held startup tree before scout dispatch and terminal settlement', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-startup-tree-cancel-'));
  const root = join(base, 'source'), output = join(base, 'out');
  await mkdir(root); await mkdir(output); await writeFile(join(root, 'file.txt'), 'Source\n');
  let entered!: () => void, release!: () => void, scoutCalls = 0;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const state: HeldStartupRender = { signal: null };
  class Runtime extends MipmuxRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (operation.kind === 'renderFileTree') { state.signal = signal; entered(); await held; }
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000,
    credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {} });
  try {
    const client = runtime.createClient({ settings: fixtureSettings, run: async () => { scoutCalls++; throw new Error('Scout must not dispatch'); } });
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, new AbortController().signal);
    const job = client.build(workspace.id, 'startup-cancel', { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', enhancementMode: 'preserve',
      purpose: 'investigation', requiredSources: [], documents: [], patches: [], discoveryHints: [], outputName: 'packet', budgetUnits: 10000 });
    await entering;
    assert(state.signal);
    const cancelling = client.cancel(job.jobId);
    assert.equal(state.signal.aborted, true, 'The admitted startup render must observe the owning job cancellation');
    assert('localSettled' in cancelling);
    assert.equal(cancelling.localSettled, false);
    release();
    const result = await client.wait(job.jobId, 10000, new AbortController().signal, () => {});
    assert.equal(result.state, 'cancelled', JSON.stringify(result));
    assert.equal(result.localSettled, true);
    assert.equal(scoutCalls, 0);
    await writeFile(join(base, 'startup-cancel-proof.json'), JSON.stringify(result, null, 2) + '\n');
  } finally { release(); await runtime.close(); }
});
