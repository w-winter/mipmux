import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime } from '../src/index.js';
import { updateValidator } from '../src/contracts/context.js';
import { sourceId } from '../src/context/material-store.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';

const request = { task: 'Inspect sources', duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'preserve' as const, purpose: 'investigation' as const,
  requiredSources: [], documents: [], patches: [], budgetUnits: 100000, discoveryHints: [], outputName: 'packet' };
const signal = () => new AbortController().signal;
interface HeldBatchRead { signal: AbortSignal | null; armed: boolean }

async function fixture() {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-selection-batch-'));
  const root = join(base, 'root'), out = join(base, 'out'); await mkdir(root); await mkdir(out);
  await writeFile(join(root, 'one.txt'), 'One\nTwo\nThree\n');
  await writeFile(join(root, 'two.txt'), 'Other\n');
  const nativeExecutable = resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`);
  return { base, root, out, options: { cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    terminationGraceMs: 100, nativeExecutable, nativeEnvironment: {} } };
}

const source = (path: string) => ({ root: 'r', path });
const upsert = (path: string) => ({ kind: 'upsert', selection: { kind: 'full', source: source(path) } });
function batch(edits: unknown[], revision: number, maxOutputBytes = 20000) {
  return updateValidator.Parse({ expectedRevision: revision, maxOutputBytes, mutation: { kind: 'batch', edits } });
}

test('batch source edits commit one revision and no partial selection on failure or receipt rejection', async () => {
  const f = await fixture(), runtime = new SmipRuntime(f.options);
  try {
    const client = runtime.createClient(null), workspace = await client.declare({ roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.out }, signal());
    const draft = await client.createDraft(workspace.id, request, signal());
    const result = await client.update(draft.id, batch([upsert('one.txt'), upsert('two.txt')], 0), signal());
    assert.equal(result.revision, 1);
    let inspection = (await client.inspect(draft.id, { view: 'metadata', continuation: null, maxOutputBytes: 20000 }, new AbortController().signal));
    assert(inspection.kind === 'metadata');
    const before = inspection;
    await assert.rejects(client.update(draft.id, batch([{ kind: 'remove', source: source('one.txt') }, upsert('absent.txt')], 1), signal()), /unavailableSource/);
    assert.deepEqual((await client.inspect(draft.id, { view: 'metadata', continuation: null, maxOutputBytes: 20000 }, new AbortController().signal)), before);
    await assert.rejects(client.update(draft.id, batch([{ kind: 'remove', source: source('one.txt') }, { kind: 'remove', source: source('two.txt') }], 1, 1), signal()), /outputBudgetTooSmall/);
    assert.deepEqual((await client.inspect(draft.id, { view: 'metadata', continuation: null, maxOutputBytes: 20000 }, new AbortController().signal)), before);
    const slices = await client.update(draft.id, batch([
      { kind: 'slices', op: 'setPaths', source: source('one.txt'), ranges: [{ start: 1, end: 1, description: 'One' }] },
      { kind: 'slices', op: 'add', source: source('one.txt'), ranges: [{ start: 2, end: 2, description: 'Two' }] },
      { kind: 'remove', source: source('two.txt') },
    ], 1), signal());
    assert.equal(slices.revision, 2);
    inspection = (await client.inspect(draft.id, { view: 'metadata', continuation: null, maxOutputBytes: 20000 }, new AbortController().signal));
    assert(inspection.kind === 'metadata');
    const selected = inspection.items.filter(item => 'kind' in item && item.kind === 'source');
    assert.equal(selected.length, 1);
    const material = selected[0]; assert(material && 'kind' in material && material.kind === 'source');
    assert.equal(material.id, sourceId(source('one.txt')));
    assert.equal(material.selection.kind, 'slices');
    if (material.selection.kind !== 'slices') assert.fail('Missing combined slice');
    assert.deepEqual(material.selection.ranges, [{ start: 1, end: 2, description: 'One; Two' }]);
    await writeFile(join(f.base, 'batch-proof.json'), JSON.stringify({ result, slices, inspection }, null, 2) + '\n');
  } finally { await runtime.close(); }
});

test('batch inference uses only final seeds and codemap mode persists across later full edits', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'Seed.swift'), 'struct Seed { let peer: Peer }');
  await writeFile(join(f.root, 'Peer.swift'), 'struct Peer { let value: Int }');
  await writeFile(join(f.root, 'Other.swift'), 'struct Other { let value: Int }');
  const runtime = new SmipRuntime(f.options);
  try {
    const client = runtime.createClient(null), workspace = await client.declare({ roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.out }, signal());
    const draft = await client.createDraft(workspace.id, request, signal());
    await writeFile(join(f.root, 'Peer.swift'), 'changed after admission');
    // Peer would fail inferred acquisition for the temporary seed, but that seed is not in the final batch state.
    const result = await client.update(draft.id, batch([upsert('Seed.swift'), { kind: 'remove', source: source('Seed.swift') }, upsert('one.txt')], 0), signal());
    assert.equal(result.revision, 1);
    const manual = await client.update(draft.id, batch([
      { kind: 'upsert', selection: { kind: 'codemap', source: source('Other.swift') } }, upsert('two.txt'),
    ], 1), signal());
    assert.equal(manual.codemapMode, 'manual'); assert.equal(manual.revision, 2);
    await writeFile(join(f.base, 'batch-final-state-proof.json'), JSON.stringify({ result, manual }, null, 2) + '\n');
  } finally { await runtime.close(); }
});

test('cancelled second batch acquisition cannot commit the first prepared source', async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const state: HeldBatchRead = { signal: null, armed: false };
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (state.armed && operation.kind === 'readSource' && operation.path === 'two.txt') {
            state.armed = false; state.signal = signal; entered(); await held;
          }
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime(f.options), abort = new AbortController();
  try {
    const client = runtime.createClient(null), workspace = await client.declare({ roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.out }, signal());
    const draft = await client.createDraft(workspace.id, request, signal()); state.armed = true;
    const work = client.update(draft.id, batch([upsert('one.txt'), upsert('two.txt')], 0), abort.signal);
    const rejected = assert.rejects(work, /cancelled|aborted/i);
    await entering; abort.abort(); assert(state.signal?.aborted); release(); await rejected;
    const inspection = (await client.inspect(draft.id, { view: 'metadata', continuation: null, maxOutputBytes: 20000 }, new AbortController().signal));
    assert(inspection.kind === 'metadata'); assert.equal(inspection.revision, 0);
    assert(!inspection.items.some(item => 'kind' in item && item.kind === 'source'));
    await writeFile(join(f.base, 'batch-cancel-proof.json'), JSON.stringify(inspection, null, 2) + '\n');
  } finally { release(); await runtime.close(); }
});

test('public MCP preview prepares the complete batch without changing the committed draft', async () => {
  const f = await fixture(), config = join(f.base, 'host.json');
  await writeFile(config, JSON.stringify({ ...f.options, search: null, git: null, discovery: null, defaultMaxOutputBytes: 20000 }));
  const client = new Client({ name: 'batch-preview', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  const identifier = Compile(Type.Object({ id: Type.String() }));
  try {
    await client.connect(transport);
    const workspace = identifier.Parse((await client.callTool({ name: 'workspace_declare', arguments: { spec: {
      roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.out } } })).structuredContent);
    const draft = identifier.Parse((await client.callTool({ name: 'draft_create', arguments: { workspaceId: workspace.id, request } })).structuredContent);
    async function inspect() {
      return (await client.callTool({ name: 'draft_inspect', arguments: { draftId: draft.id,
        input: { view: 'metadata', continuation: null } } })).structuredContent;
    }
    const before = await inspect(), input = { expectedRevision: 0, edits: [upsert('one.txt'), upsert('two.txt')] };
    const result = await client.callTool({ name: 'draft_preview', arguments: { draftId: draft.id, input } });
    assert.equal(result.isError, false, JSON.stringify(result));
    const preview = Compile(Type.Object({ kind: Type.Literal('preview'), revision: Type.Literal(0),
      items: Type.Array(Type.Object({ kind: Type.Literal('source') }), { minItems: 2, maxItems: 2 }) })).Parse(result.structuredContent);
    assert(JSON.stringify(preview).includes('one.txt') && JSON.stringify(preview).includes('two.txt'));
    assert.deepEqual(await inspect(), before);
    const rejected = await client.callTool({ name: 'draft_preview', arguments: { draftId: draft.id, input, maxOutputBytes: 1 } });
    assert.equal(rejected.isError, true); assert(JSON.stringify(rejected).includes('outputBudgetTooSmall'));
    assert.deepEqual(await inspect(), before);
    const committed = await client.callTool({ name: 'draft_update', arguments: { draftId: draft.id,
      input: { expectedRevision: 0, mutation: { kind: 'batch', edits: input.edits } } } });
    assert.equal(committed.isError, false, JSON.stringify(committed));
    assert(Compile(Type.Object({ kind: Type.Literal('mutation'), revision: Type.Literal(1) })).Check(committed.structuredContent));
    await writeFile(join(f.base, 'batch-preview-proof.json'), JSON.stringify({ result, before, rejected, committed }, null, 2) + '\n');
  } finally { await client.close(); }
});
