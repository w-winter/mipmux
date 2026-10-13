import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { updateValidator } from '../src/contracts/context.js';

const identifier = Compile(Type.Object({ id: Type.String() }));
const mutationReply = Compile(Type.Object({ kind: Type.Literal('mutation'), revision: Type.Integer() }));
const metadata = Compile(Type.Object({ kind: Type.Literal('metadata'), revision: Type.Integer(), items: Type.Array(Type.Object({ kind: Type.String() })) }));
interface HeldSliceCalculation { signal: AbortSignal | null }

const request = { task: 'Inspect selected source', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
  requiredSources: [], documents: [], patches: [], budgetUnits: 100000, discoveryHints: [], outputName: 'packet' };

async function hostFixture(prefix: string) {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-' + prefix));
  const root = join(base, 'root'), output = join(base, 'out'); await mkdir(root); await mkdir(output);
  const body = Array.from({ length: 10 }, (_, index) => `Line ${index + 1}\n`).join('');
  await writeFile(join(root, 'file.txt'), body);
  const options = { cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {} };
  return { base, root, output, body, options };
}

test('public MCP slice mutations coalesce descriptions, subtract ranges and restore full content when the last slice is removed', async () => {
  const f = await hostFixture('selection-slices-'), config = join(f.base, 'host.json');
  await writeFile(config, JSON.stringify({ ...f.options, search: null, git: null, discovery: null, defaultMaxOutputBytes: 20000 }));
  const client = new Client({ name: 'selection-slices', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  const proof: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = identifier.Parse((await client.callTool({ name: 'workspace_declare', arguments: {
      spec: { roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.output } } })).structuredContent);
    const draft = identifier.Parse((await client.callTool({ name: 'draft_create', arguments: { workspaceId: workspace.id, request } })).structuredContent);
    let revision = 0;
    const source = { root: 'r', path: 'file.txt' };
    async function change(op: string, ranges: { start: number; end: number; description: string | null }[], maxOutputBytes = 20000) {
      const reply = await client.callTool({ name: 'draft_update', arguments: { draftId: draft.id, maxOutputBytes,
        input: { expectedRevision: revision, mutation: { kind: 'slices', op, source, ranges } } } });
      proof.push(reply);
      if (!reply.isError) revision = mutationReply.Parse(reply.structuredContent).revision;
      return reply;
    }
    async function selected() {
      const reply = await client.callTool({ name: 'draft_inspect', arguments: { draftId: draft.id,
        input: { view: 'metadata', continuation: null } } });
      return Compile(Type.Object({ items: Type.Array(Type.Union([
        Type.Object({ kind: Type.Literal('source'), selection: Type.Object({ kind: Type.String(), source: Type.Object({ root: Type.String(), path: Type.String() }),
          ranges: Type.Optional(Type.Array(Type.Object({ start: Type.Integer(), end: Type.Integer(), description: Type.Union([Type.String(), Type.Null()]) }))) }),
        }), Type.Object({ kind: Type.Literal('prompt') }),
      ])) })).Parse(reply.structuredContent).items.find(item => item.kind === 'source');
    }
    assert.equal((await change('add', [{ start: 2, end: 4, description: 'First' }])).isError, false);
    assert.equal((await change('add', [{ start: 4, end: 6, description: 'Second' }])).isError, false);
    let item = await selected(); assert(item?.kind === 'source');
    assert.deepEqual(item.selection.ranges, [{ start: 2, end: 6, description: 'First; Second' }]);
    assert.equal((await change('remove', [{ start: 3, end: 4, description: null }])).isError, false);
    item = await selected(); assert(item?.kind === 'source');
    assert.deepEqual(item.selection.ranges, [{ start: 2, end: 2, description: 'First; Second' }, { start: 5, end: 6, description: 'First; Second' }]);
    const before = revision;
    assert.equal((await change('setPaths', [{ start: 9, end: 11, description: null }])).isError, true);
    assert.equal(revision, before);
    assert.equal((await change('setPaths', [{ start: 1, end: 1, description: null }], 1)).isError, true);
    assert.equal(revision, before);
    assert.equal((await change('remove', [])).isError, false);
    item = await selected(); assert(item?.kind === 'source'); assert.equal(item.selection.kind, 'full');
    const complete = await client.callTool({ name: 'draft_finalize', arguments: { draftId: draft.id } });
    assert.equal(complete.isError, false, JSON.stringify(complete));
    const result = Compile(Type.Object({ kind: Type.Literal('ready'), directory: Type.String() })).Parse(complete.structuredContent);
    assert((await readFile(join(result.directory, 'context.md'), 'utf8')).includes(f.body));
    const unlabeled = identifier.Parse((await client.callTool({ name: 'draft_create', arguments: { workspaceId: workspace.id,
      request: { ...request, outputName: 'unlabeled' } } })).structuredContent);
    assert.equal((await client.callTool({ name: 'draft_update', arguments: { draftId: unlabeled.id, input: { expectedRevision: 0,
      mutation: { kind: 'slices', op: 'setPaths', source, ranges: [{ start: 2, end: 3, description: null }] } } } })).isError, false);
    const unlabeledResult = Compile(Type.Object({ kind: Type.Literal('ready'), directory: Type.String() })).Parse(
      (await client.callTool({ name: 'draft_finalize', arguments: { draftId: unlabeled.id } })).structuredContent);
    const unlabeledPacket = await readFile(join(unlabeledResult.directory, 'context.md'), 'utf8');
    assert(!unlabeledPacket.includes('Lines 2-3: null'), 'An absent source description must not become instruction text');
    await writeFile(join(f.base, 'selection-slices-proof.json'), JSON.stringify({ proof, complete }, null, 2) + '\n');
  } finally { await client.close(); }
});

test('cancelling native slice preparation leaves the committed draft unchanged and joins its owned work', async () => {
  const f = await hostFixture('selection-slices-cancel-');
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const state: HeldSliceCalculation = { signal: null };
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (operation.kind === 'calculateSliceRanges') { state.signal = signal; entered(); await held; }
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime(f.options), abort = new AbortController();
  try {
    const client = runtime.createClient(null), signal = new AbortController().signal;
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.output }, signal);
    const draft = await client.createDraft(workspace.id, { ...request, enhancementMode: 'preserve', purpose: 'investigation' }, signal);
    const input = { expectedRevision: 0, maxOutputBytes: 20000, mutation: { kind: 'slices', op: 'add', source: { root: 'r', path: 'file.txt' },
      ranges: [{ start: 2, end: 4, description: 'Cancelled slice' }] } };
    // Drive the public draft owner with the boundary's current schema, rather than bypassing its mutation policy.
    const work = client.update(draft.id, updateValidator.Parse(input), abort.signal);
    const rejected = assert.rejects(work, /cancelled|aborted/i);
    await entering; abort.abort(); assert(state.signal?.aborted);
    release(); await rejected;
    const result = metadata.Parse((await client.inspect(draft.id, { view: 'metadata', continuation: null, maxOutputBytes: 20000 }, new AbortController().signal)));
    assert.equal(result.revision, 0); assert(!result.items.some(item => item.kind === 'source'));
    await writeFile(join(f.base, 'slice-cancellation-proof.json'), JSON.stringify(result, null, 2) + '\n');
  } finally { release(); await runtime.close(); }
});
