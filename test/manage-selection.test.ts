import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { SourceSelection, verifyBundle, verifyCurrentBundle, SmipRuntime } from '../src/index.js';
import { selectionValidator, SelectionInput } from '../src/contracts/selection.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { inventoryValidator } from '../src/contracts/inventory.js';

const identifier = Compile(Type.Object({ id: Type.String() }));
const sourceMetadata = Type.Object({ kind: Type.Literal('source'), selection: SourceSelection,
  selectionOrigin: Type.Enum(['explicit', 'inferred']) });
const inspection = Compile(Type.Object({ revision: Type.Integer(), codemapMode: Type.Enum(['automatic', 'manual']),
  items: Type.Array(Type.Union([sourceMetadata, Type.Object({ kind: Type.Literal('prompt'), prompt: Type.String() })])) }));
const ready = Compile(Type.Object({ kind: Type.Literal('ready'), directory: Type.String() }));

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'smip-manage-selection-')));
  const root = join(base, 'source'), output = join(base, 'out'), config = join(base, 'host.json');
  await mkdir(join(root, 'zone'), { recursive: true }); await mkdir(output);
  await writeFile(join(root, 'Main.swift'), 'struct Main {\n  let value: Int\n}\n');
  await writeFile(join(root, 'Empty.swift'), '');
  const invalidUTF16Surrogate = Buffer.from('//4A2A==', 'base64');
  await writeFile(join(root, 'Undecodable.swift'), invalidUTF16Surrogate);
  await writeFile(join(root, 'zone/Peer.swift'), 'struct Peer {\n  let title: String\n}\n');
  await writeFile(join(root, 'zone/notes.txt'), 'First\nSecond\nThird\n');
  await mkdir(join(root, 'private'));
  await writeFile(join(root, '.repo_ignore'), 'private/\n');
  await writeFile(join(root, 'private/Hidden.swift'), 'struct ExplicitlyManaged {\n  let value: Int\n}\n');
  await writeFile(config, JSON.stringify({ cachePath: join(base, 'cache'), contextBudgetUnits: 200000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, search: null, git: null,
    discovery: null, defaultMaxOutputBytes: 30000 }));
  const client = new Client({ name: 'source-selection', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  await client.connect(transport);
  const declared = await client.callTool({ name: 'workspace_declare', arguments: { spec: {
    roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output } } });
  assert.equal(declared.isError, false, JSON.stringify(declared));
  const created = await client.callTool({ name: 'draft_create', arguments: {
    workspaceId: identifier.Parse(declared.structuredContent).id, request: {
      task: 'Inspect source selection behavior', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      requiredSources: [], documents: [], patches: [], discoveryHints: [], budgetUnits: 100000, outputName: 'packet',
    } } });
  assert.equal(created.isError, false, JSON.stringify(created));
  const draftId = identifier.Parse(created.structuredContent).id;
  const select = (input: Static<typeof SelectionInput>, maxOutputBytes = 30000) => client.callTool({
    name: 'manage_selection', arguments: { draftId, input, maxOutputBytes },
  });
  const inspect = async () => {
    const reply = await client.callTool({ name: 'draft_inspect', arguments: {
      draftId, input: { view: 'metadata', continuation: null }, maxOutputBytes: 30000,
    } });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    return inspection.Parse(reply.structuredContent);
  };
  return { base, root, output, client, draftId, select, inspect, workspaceId: identifier.Parse(declared.structuredContent).id };
}

test('public source selection preserves slices on full add and source promotion/manual-mode semantics', async () => {
  const f = await fixture();
  const receipts = [];
  try {
    let reply = await f.select({ op: 'set', mode: 'slices', slices: [{ path: 'r/zone/notes.txt',
      ranges: [{ start_line: 2, end_line: 2, description: 'Second line' }] }] });
    assert.equal(reply.isError, false, JSON.stringify(reply)); receipts.push(reply);
    reply = await f.select({ op: 'add', paths: ['r/zone'], mode: 'full', strict: true });
    assert.equal(reply.isError, false, JSON.stringify(reply)); receipts.push(reply);
    let state = await f.inspect();
    const notes = state.items.find(item => item.kind === 'source' && item.selection.source.path === 'zone/notes.txt');
    assert(notes?.kind === 'source'); assert.equal(notes.selection.kind, 'slices');
    assert(state.items.some(item => item.kind === 'source' && item.selection.source.path === 'zone/Peer.swift'));
    reply = await f.select({ op: 'demote', paths: ['r/zone/Peer.swift'] });
    assert.equal(reply.isError, false, JSON.stringify(reply)); receipts.push(reply);
    state = await f.inspect(); assert.equal(state.codemapMode, 'manual');
    assert(state.items.some(item => item.kind === 'source' && item.selection.source.path === 'zone/Peer.swift'
      && item.selection.kind === 'codemap'));
    reply = await f.select({ op: 'remove', paths: ['r/zone/Peer.swift'], mode: 'full', strict: true });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    assert((await f.inspect()).items.some(item => item.kind === 'source' && item.selection.source.path === 'zone/Peer.swift'
      && item.selection.kind === 'codemap'));
    reply = await f.select({ op: 'promote', paths: ['r/zone/Peer.swift'] });
    assert.equal(reply.isError, false, JSON.stringify(reply)); receipts.push(reply);
    state = await f.inspect(); assert.equal(state.codemapMode, 'manual');
    assert(state.items.some(item => item.kind === 'source' && item.selection.source.path === 'zone/Peer.swift'
      && item.selection.kind === 'full'));
    await writeFile(join(f.base, 'representation-receipt.json'), JSON.stringify({ receipts, state }, null, 2) + '\n');
  } finally { await f.client.close(); }
});

test('selection receipts expose source summaries, slice DTOs and the codemaps-only view', async () => {
  const f = await fixture();
  const range = Type.Object({ start_line: Type.Integer(), end_line: Type.Integer(), description: Type.Optional(Type.String()) });
  const file = Type.Object({ path: Type.String(), tokens: Type.Integer(), render_mode: Type.String(), ranges: Type.Optional(Type.Array(range)),
    root_path: Type.String(), path_within_root: Type.String() });
  const replySchema = Compile(Type.Object({ files: Type.Array(file), total_tokens: Type.Integer(), code_map_usage: Type.String(),
    summary: Type.Object({ full_count: Type.Integer(), slice_count: Type.Integer(), codemap_count: Type.Integer(),
      full_tokens: Type.Integer(), slice_tokens: Type.Integer(), codemap_tokens: Type.Integer() }),
    file_slices: Type.Array(Type.Object({ path: Type.String(), ranges: Type.Array(range), root_path: Type.String(), path_within_root: Type.String() })),
  }));
  try {
    let reply = await f.select({ op: 'set', paths: ['r/Main.swift'], slices: [{ path: 'r/zone/notes.txt',
      ranges: [{ start_line: 2, end_line: 3, description: 'Selected notes' }] }] });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    reply = await f.select({ op: 'add', mode: 'codemap_only', paths: ['r/zone/Peer.swift'], view: 'files' });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    const full = replySchema.Parse(reply.structuredContent);
    assert.equal(full.code_map_usage, 'auto');
    assert.deepEqual([full.summary.full_count, full.summary.slice_count, full.summary.codemap_count], [1, 1, 1]);
    assert.equal(full.total_tokens, full.summary.full_tokens + full.summary.slice_tokens + full.summary.codemap_tokens);
    const slice = full.files.find(file => file.render_mode === 'slice');
    assert(slice);
    assert.deepEqual(slice.ranges, [{ start_line: 2, end_line: 3, description: 'Selected notes' }]);
    assert.deepEqual(full.file_slices, [{ path: 'zone/notes.txt', ranges: slice.ranges, root_path: 'r', path_within_root: 'zone/notes.txt' }]);
    const before = await f.inspect();
    reply = await f.client.callTool({ name: 'manage_selection', arguments: { draftId: f.draftId, input: { op: 'get', view: 'codemaps' } } });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    const filtered = replySchema.Parse(reply.structuredContent);
    assert.deepEqual(filtered.files, full.files.filter(file => file.render_mode === 'codemap'));
    assert.deepEqual(filtered.file_slices, []);
    assert.deepEqual(filtered.summary, { full_count: 0, slice_count: 0, codemap_count: 1,
      full_tokens: 0, slice_tokens: 0, codemap_tokens: full.summary.codemap_tokens });
    assert.equal(filtered.total_tokens, full.summary.codemap_tokens);
    assert.deepEqual(await f.inspect(), before);
    await writeFile(join(f.base, 'selection-views-receipt.json'), JSON.stringify({ full, filtered, before }, null, 2) + '\n');
  } finally { await f.client.close(); }
});

test('selection content view uses the source full-file and described-slice blocks', async () => {
  const f = await fixture();
  const blocks = Compile(Type.Object({ blocks: Type.Array(Type.String()) }));
  try {
    let reply = await f.select({ op: 'set', paths: ['r/Main.swift'], view: 'content' });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    assert.deepEqual(blocks.Parse(reply.structuredContent).blocks,
      ['File: Main.swift\n```swift\nstruct Main {\n  let value: Int\n}\n\n```']);
    reply = await f.select({ op: 'clear' });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    reply = await f.select({ op: 'set', slices: [{ path: 'r/zone/notes.txt',
      ranges: [{ start_line: 2, end_line: 3, description: 'Selected notes' }] }], view: 'content' });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    assert.deepEqual(blocks.Parse(reply.structuredContent).blocks,
      ['File: zone/notes.txt\n(lines 2-3: Selected notes)\n```txt\nSecond\nThird\n\n```']);
    await writeFile(join(f.base, 'selection-content-block-receipt.json'), JSON.stringify({ reply }, null, 2) + '\n');
  } finally { await f.client.close(); }
});

test('selection commits before reply rendering and survives cancellation, failure and a later mutation', async () => {
  const f = await fixture(); await f.client.close();
  const receipts = [];
  for (const scenario of ['cancel', 'revision', 'failure'] as const) {
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let armed = true;
    class Runtime extends SmipRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
            if (armed && operation.kind === 'renderSelectionReply') {
              armed = false; entered(); await held;
              if (scenario === 'failure') throw new Error('Held reply failed');
            }
            return super.request(operation, signal);
          }
        }
        return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
      }
    }
    const runtime = new Runtime({ cachePath: join(f.base, scenario + '-cache'), contextBudgetUnits: 200000, credentialPaths: [],
      nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
    try {
      const signal = () => new AbortController().signal;
      const owner = await runtime.declare({ roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.output }, signal());
      const draft = await owner.createDraft({ task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
        requiredSources: [], documents: [], patches: [], budgetUnits: 100000, discoveryHints: [], outputName: scenario }, signal());
      const abort = new AbortController();
      const work = draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({
        op: 'add', paths: ['r/Main.swift'], maxOutputBytes: 30000 })), abort.signal);
      await Promise.race([entering, work.then(() => { throw new Error('Selection settled before reply rendering'); })]);
      const committed = (await draft.inspect({ view: 'metadata', continuation: null, maxOutputBytes: 30000 }, new AbortController().signal));
      assert(committed.kind === 'metadata'); assert.equal(committed.revision, 1);
      assert(committed.items.some(item => 'kind' in item && item.kind === 'source' && item.selection.source.path === 'Main.swift'));
      const rejected = scenario === 'revision' ? null
        : assert.rejects(work, scenario === 'cancel' ? /cancelled|aborted|nativeWorkerClosed/i : /Held reply failed/);
      if (scenario === 'cancel') abort.abort();
      else if (scenario === 'revision') await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({
        op: 'clear', expectedRevision: 1, maxOutputBytes: 30000 })), signal());
      release();
      if (rejected) await rejected;
      else {
        const reply = await work;
        assert.equal(reply.revision, 1);
        assert(reply.files.some(file => file.path === 'Main.swift'));
        receipts.push({ scenario, reply });
      }
      const state = (await draft.inspect({ view: 'metadata', continuation: null, maxOutputBytes: 30000 }, new AbortController().signal));
      assert(state.kind === 'metadata');
      assert.equal(state.revision, scenario === 'revision' ? 2 : 1);
      assert.equal(state.items.some(item => 'kind' in item && item.kind === 'source'), scenario !== 'revision');
      receipts.push({ scenario, committed, state });
      await draft.close(); await owner.close();
    } finally { release(); await runtime.close(); }
  }
  await writeFile(join(f.base, 'selection-reply-lifecycle-receipt.json'), JSON.stringify(receipts, null, 2) + '\n');
});

test('selection reply-size rejection retains a mutation but preview remains non-mutating', async () => {
  const f = await fixture();
  const receipts = [];
  try {
    const before = await f.inspect();
    const preview = await f.select({ op: 'preview', paths: ['r/Main.swift'] }, 1);
    assert.equal(preview.isError, true); assert(JSON.stringify(preview).includes('outputBudgetTooSmall'));
    assert.deepEqual(await f.inspect(), before);
    receipts.push(preview);
    const rejected = await f.select({ op: 'set', paths: ['r/Main.swift'] }, 1);
    assert.equal(rejected.isError, true); assert(JSON.stringify(rejected).includes('outputBudgetTooSmall'));
    const state = await f.inspect(); assert.equal(state.revision, 1);
    assert(state.items.some(item => item.kind === 'source' && item.selection.source.path === 'Main.swift'));
    const reply = await f.select({ op: 'get' });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    const current = Compile(Type.Object({ revision: Type.Integer(), files: Type.Array(Type.Object({ path: Type.String() })) })).Parse(reply.structuredContent);
    assert.equal(current.revision, 1); assert.deepEqual(current.files.map(file => file.path), ['Main.swift']);
    const noOp = await f.select({ op: 'add', paths: ['r/Main.swift'] }, 1);
    assert.equal(noOp.isError, true); assert.deepEqual(await f.inspect(), state);
    receipts.push(rejected, reply, noOp);
    await writeFile(join(f.base, 'selection-reply-cap-receipt.json'), JSON.stringify({ receipts, before, state }, null, 2) + '\n');
  } finally { await f.client.close(); }
});

test('codemap-only selection retains a supported file with no rendered symbols and reports it as unmapped', async () => {
  const f = await fixture();
  const replySchema = Compile(Type.Object({ files: Type.Array(Type.Object({ path: Type.String() })),
    blocks: Type.Array(Type.String()), code_structure: Type.Object({ file_count: Type.Integer(), content: Type.String(),
      unmapped_paths: Type.Array(Type.String()) }) }));
  const receipts = [];
  try {
    let reply = await f.select({ op: 'set', mode: 'codemap_only', paths: ['r/Empty.swift'], view: 'content' });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    let projected = replySchema.Parse(reply.structuredContent);
    assert.deepEqual(projected.files, []);
    assert.deepEqual(projected.blocks, []);
    assert.deepEqual(projected.code_structure, { file_count: 0, content: '', unmapped_paths: ['Empty.swift'] });
    let state = await f.inspect();
    assert(state.items.some(item => item.kind === 'source' && item.selection.kind === 'codemap' &&
      item.selection.source.path === 'Empty.swift'));
    receipts.push(reply);
    reply = await f.select({ op: 'promote', paths: ['r/Empty.swift'] });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    reply = await f.select({ op: 'demote', paths: ['r/Empty.swift'], view: 'content' });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    projected = replySchema.Parse(reply.structuredContent);
    assert.deepEqual(projected.files, []);
    assert.deepEqual(projected.code_structure.unmapped_paths, ['Empty.swift']);
    state = await f.inspect();
    assert.equal(state.codemapMode, 'manual');
    receipts.push(reply);
    const finalized = await f.client.callTool({ name: 'draft_finalize', arguments: { draftId: f.draftId } });
    assert.equal(finalized.isError, false, JSON.stringify(finalized));
    const bundle = await verifyBundle(ready.Parse(finalized.structuredContent).directory);
    const material = bundle.manifest.materials.find(record => record.kind === 'source' && record.selection.source.path === 'Empty.swift');
    assert(material?.kind === 'source' && material.selection.kind === 'codemap');
    assert.deepEqual(material.spans, []);
    await writeFile(join(f.base, 'unrendered-codemap-receipt.json'), JSON.stringify({ receipts, bundle }, null, 2) + '\n');
  } finally { await f.client.close(); }
});

test('undecodable codemap-only membership retains raw evidence and passes saved/current verification', async () => {
  const f = await fixture();
  const replySchema = Compile(Type.Object({ files: Type.Array(Type.Unknown()), blocks: Type.Array(Type.String()),
    code_structure: Type.Object({ unmapped_paths: Type.Array(Type.String()) }) }));
  const manifestSchema = Compile(Type.Object({ materials: Type.Array(Type.Object({ kind: Type.Literal('source'),
    selection: SourceSelection, decoding: Type.Object({ kind: Type.Literal('undecodable') }), spans: Type.Array(Type.Unknown()) })) }));
  const runtime = new SmipRuntime({ cachePath: join(f.base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  try {
    const reply = await f.select({ op: 'set', mode: 'codemap_only', paths: ['r/Undecodable.swift'], view: 'content' });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    const projected = replySchema.Parse(reply.structuredContent);
    assert.deepEqual(projected.files, []);
    assert.deepEqual(projected.blocks, []);
    assert.deepEqual(projected.code_structure.unmapped_paths, ['Undecodable.swift']);
    const before = await f.inspect();
    const promoted = await f.select({ op: 'promote', paths: ['r/Undecodable.swift'] });
    assert.equal(promoted.isError, true, JSON.stringify(promoted));
    assert.deepEqual(await f.inspect(), before);
    const finalized = await f.client.callTool({ name: 'draft_finalize', arguments: { draftId: f.draftId } });
    assert.equal(finalized.isError, false, JSON.stringify(finalized));
    const directory = ready.Parse(finalized.structuredContent).directory;
    const verified = await verifyBundle(directory);
    const material = manifestSchema.Parse(verified.manifest).materials[0]!;
    assert.equal(material.selection.kind, 'codemap');
    assert.deepEqual(material.spans, []);
    const current = await verifyCurrentBundle(directory, runtime, new AbortController().signal);
    assert.equal(current.kind, 'currentVerified');
    await writeFile(join(f.root, 'Undecodable.swift'), 'struct NowDecoded { let value: Int }\n');
    await assert.rejects(verifyCurrentBundle(directory, runtime, new AbortController().signal), /sourceChanged/);
    await writeFile(join(f.base, 'undecodable-codemap-receipt.json'), JSON.stringify({ reply, before, verified, current }, null, 2) + '\n');
  } finally { await f.client.close(); await runtime.close(); }
});

test('source set rejects invalid inputs even without strict and preview never commits selection', async () => {
  const f = await fixture();
  try {
    let reply = await f.select({ op: 'set', paths: ['r/Main.swift'] });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    const before = await f.inspect();
    reply = await f.select({ op: 'set', paths: ['r/zone/notes.txt', 'r/missing.txt'], strict: false });
    assert.equal(reply.isError, true, JSON.stringify(reply));
    assert.deepEqual(await f.inspect(), before);
    reply = await f.select({ op: 'preview', paths: ['r/zone'], strict: true });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    assert.deepEqual(await f.inspect(), before);
    reply = await f.select({ op: 'demote', paths: ['r/zone'], strict: false });
    assert.equal(reply.isError, true, JSON.stringify(reply));
    assert.deepEqual(await f.inspect(), before);
    await writeFile(join(f.base, 'transaction-receipt.json'), JSON.stringify({ before, after: await f.inspect() }, null, 2) + '\n');
  } finally { await f.client.close(); }
});

test('strict selection failures retain source path hints and leave selection unchanged', async () => {
  const f = await fixture();
  const failure = Compile(Type.Object({ message: Type.String() }));
  const receipts = [];
  try {
    const paths = [' /outside-one/File.swift ', '\n', '/outside-two/File.swift', '/outside-three/File.swift'];
    for (const op of ['add', 'remove', 'preview'] as const) {
      const reply = await f.select({ op, paths, strict: true });
      assert.equal(reply.isError, true, JSON.stringify(reply));
      assert.equal(failure.Parse(reply.structuredContent).message,
        "No provided paths matched any files or folders for '" + op + "'. Loaded roots: r → " + f.root +
        " Provide either: (a) Root-name + relative path (e.g., 'Root/Sub/Path.swift'), or (b) a full absolute path under a loaded root." +
        ' Not under any loaded root: /outside-one/File.swift, /outside-two/File.swift');
      receipts.push(reply);
    }
    const invalidSlices = await f.select({ op: 'add', paths: ['r/Main.swift'], slices: [null], strict: true });
    assert.equal(invalidSlices.isError, true, JSON.stringify(invalidSlices));
    assert.equal(failure.Parse(invalidSlices.structuredContent).message, 'No valid slices parsed from provided specification');
    for (const op of ['promote', 'demote'] as const) {
      const reply = await f.select({ op, paths: ['r/zone'] });
      assert.equal(reply.isError, true, JSON.stringify(reply));
      assert(failure.Parse(reply.structuredContent).message.startsWith('Invalid selection inputs: '));
      receipts.push(reply);
    }
    const emptyPreview = await f.select({ op: 'preview', mode: 'codemap_only', paths: ['r/Empty.swift'], strict: true });
    assert.equal(emptyPreview.isError, true, JSON.stringify(emptyPreview));
    assert(failure.Parse(emptyPreview.structuredContent).message.startsWith("No provided paths matched any files or folders for 'preview'."));
    const state = await f.inspect();
    assert.equal(state.revision, 0);
    assert(!state.items.some(item => item.kind === 'source'));
    await writeFile(join(f.base, 'selection-error-hints-receipt.json'), JSON.stringify({ receipts, invalidSlices, emptyPreview, state }, null, 2) + '\n');
  } finally { await f.client.close(); }
});

test('absolute explicit selection admits ignored regular sources and preserves saved packet evidence', async () => {
  const f = await fixture();
  try {
    const text = 'struct ExplicitlyManaged {\n  let value: Int\n}\n';
    const reply = await f.select({ op: 'add', paths: [join(f.root, 'private/Hidden.swift')], strict: true });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    const state = await f.inspect();
    assert(state.items.some(item => item.kind === 'source' && item.selection.source.path === 'private/Hidden.swift'
      && item.selection.kind === 'full'));
    const finalized = await f.client.callTool({ name: 'draft_finalize', arguments: { draftId: f.draftId } });
    assert.equal(finalized.isError, false, JSON.stringify(finalized));
    const packet = ready.Parse(finalized.structuredContent);
    const verified = await verifyBundle(packet.directory);
    assert(verified.manifest.materials.some(record => record.kind === 'source'
      && record.selection.source.path === 'private/Hidden.swift'));
    assert((await readFile(join(packet.directory, 'context.md'), 'utf8')).includes(text));
    await writeFile(join(f.base, 'explicit-source-receipt.json'), JSON.stringify({ state, directory: packet.directory }, null, 2) + '\n');
  } finally { await f.client.close(); }
});

test('a rejected selection retains explicit workspace registration but ordinary discovery excludes it', async () => {
  const f = await fixture();
  try {
    const before = await f.inspect();
    const rejected = await f.select({ op: 'set', paths: [join(f.root, 'private/Hidden.swift'), 'r/missing.txt'] });
    assert.equal(rejected.isError, true, JSON.stringify(rejected));
    assert.deepEqual(await f.inspect(), before);
    const exact = await f.client.callTool({ name: 'read_file', arguments: { workspaceId: f.workspaceId,
      input: { root: 'r', path: 'private/Hidden.swift' } } });
    assert.equal(exact.isError, false, JSON.stringify(exact));
    const tree = await f.client.callTool({ name: 'get_file_tree', arguments: { workspaceId: f.workspaceId,
      input: { type: 'files', mode: 'full' } } });
    assert.equal(tree.isError, false, JSON.stringify(tree));
    const decoded = Compile(Type.Object({ tree: Type.String() })).Parse(tree.structuredContent);
    assert(!decoded.tree.includes('Hidden.swift'));
    await writeFile(join(f.root, 'private/Hidden.swift'), 'struct RefreshedManaged {}\n');
    await writeFile(join(f.root, '.repo_ignore'), 'private/\n# refreshed control\n');
    const refreshed = await f.client.callTool({ name: 'workspace_refresh', arguments: { workspaceId: f.workspaceId } });
    assert.equal(refreshed.isError, false, JSON.stringify(refreshed));
    const reread = await f.client.callTool({ name: 'read_file', arguments: { workspaceId: f.workspaceId,
      input: { root: 'r', path: 'private/Hidden.swift' } } });
    assert.equal(reread.isError, false, JSON.stringify(reread));
    assert(JSON.stringify(reread.structuredContent).includes('RefreshedManaged'));
    await writeFile(join(f.base, 'rejected-registration-receipt.json'), JSON.stringify({ before, exact, tree }, null, 2) + '\n');
  } finally { await f.client.close(); }
});

test('cancellation during codemap extraction retains committed membership and get reacquires its presentation', async () => {
  const f = await fixture(); await f.client.close();
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let armed = true;
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (armed && operation.kind === 'extract') { armed = false; entered(); await held; }
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ cachePath: join(f.base, 'cancel-cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = () => new AbortController().signal;
  armed = false;
  try {
    const client = runtime.createClient(null), spec = { roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.output };
    const workspace = await client.declare(spec, signal());
    const owner = await runtime.declare(spec, signal());
    const draft = await client.createDraft(workspace.id, { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      requiredSources: [], documents: [], patches: [], budgetUnits: 100000, discoveryHints: [], outputName: 'cancel' }, signal());
    armed = true;
    const abort = new AbortController();
    const work = client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
      op: 'add', mode: 'codemap_only', paths: [join(f.root, 'private/Hidden.swift')], maxOutputBytes: 30000 })), abort.signal);
    const rejected = assert.rejects(work, /cancelled|aborted|nativeWorkerClosed/i);
    await Promise.race([entering, work.then(() => { throw new Error('Selection settled before post-registration extraction'); })]);
    const committed = (await client.inspect(draft.id, { view: 'metadata', continuation: null, maxOutputBytes: 30000 }, new AbortController().signal));
    assert(committed.kind === 'metadata'); assert.equal(committed.revision, 1);
    assert(committed.items.some(item => 'kind' in item && item.kind === 'source' && item.selection.kind === 'codemap'));
    abort.abort(); release(); await rejected;
    const state = (await client.inspect(draft.id, { view: 'metadata', continuation: null, maxOutputBytes: 30000 }, new AbortController().signal));
    assert(state.kind === 'metadata'); assert.equal(state.revision, 1);
    const blocked = await client.finalize(draft.id, signal());
    assert.equal(blocked.kind, 'blocked');
    const operation = await owner.openOperation(signal());
    try {
      assert.equal((await operation.readSource({ root: 'r', path: 'private/Hidden.swift' })).text,
        'struct ExplicitlyManaged {\n  let value: Int\n}\n');
      const resumed = await client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
        op: 'get', view: 'content', maxOutputBytes: 30000 })), signal());
      assert(resumed.blocks?.some(body => body.includes('ExplicitlyManaged')));
      assert.equal(resumed.revision, 1);
      const finalized = await client.finalize(draft.id, signal());
      assert.equal(finalized.kind, 'ready');
      if (finalized.kind === 'ready') await verifyBundle(finalized.directory);
      await writeFile(join(f.base, 'cancel-registration-receipt.json'), JSON.stringify({ committed, state, blocked, resumed, finalized,
        enumeration: operation.snapshot.enumeration }, null, 2) + '\n');
    } finally { await operation.close(); await owner.close(); await client.close(); }
  } finally { release(); await runtime.close(); }
});

test('get, clear and rejected representation syntax do not acquire unrelated explicit files', async () => {
  for (const op of ['get', 'clear', 'demote'] as const) {
    const f = await fixture();
    try {
      const paths = [join(f.root, 'private/Hidden.swift')];
      const input = op === 'demote' ? { op, paths,
        slices: [{ path: 'r/zone/notes.txt', ranges: [{ start_line: 1, end_line: 1 }] }] } : { op, paths };
      const reply = await f.select(input);
      assert.equal(reply.isError, op === 'demote', JSON.stringify(reply));
      const refreshed = await f.client.callTool({ name: 'workspace_refresh', arguments: { workspaceId: f.workspaceId } });
      assert.equal(refreshed.isError, false, JSON.stringify(refreshed));
      const snapshot = inventoryValidator.Parse(refreshed.structuredContent);
      assert(!snapshot.entries.some(entry => entry.kind === 'file' && entry.path === 'private/Hidden.swift'), op);
      await writeFile(join(f.base, 'non-acquiring-selection-receipt.json'), JSON.stringify({ op, reply, inventory: snapshot.inventoryDigest }, null, 2) + '\n');
    } finally { await f.client.close(); }
  }
});

test('the source readiness deadline reports pending codemaps and a later get completes the same selection', async () => {
  const f = await fixture(); await f.client.close();
  const sourceReadinessMilliseconds = 10000;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let armed = false, timer: ReturnType<typeof setTimeout> | null = null;
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (armed && operation.kind === 'extract') {
            armed = false;
            timer = setTimeout(release, sourceReadinessMilliseconds);
            await held;
          }
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ cachePath: join(f.base, 'deadline-cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = () => new AbortController().signal;
  const client = runtime.createClient(null);
  try {
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.output }, signal());
    const draft = await client.createDraft(workspace.id, { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      requiredSources: [], documents: [{ kind: 'suppliedDocument', id: 'evidence', role: 'evidence', origin: 'fixture', text: 'Required evidence' },
        { kind: 'suppliedDocument', id: 'supporting-evidence', role: 'evidence', origin: 'fixture', text: 'Supporting evidence' }],
      patches: [], budgetUnits: 100000, discoveryHints: [], outputName: 'deadline' }, signal());
    armed = true;
    const pending = await client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
      op: 'set', mode: 'codemap_only', paths: [join(f.root, 'private/Hidden.swift')], view: 'content', maxOutputBytes: 30000 })), signal());
    assert.equal(pending.revision, 1); assert.deepEqual(pending.files, []); assert.deepEqual(pending.blocks, []);
    assert.deepEqual(pending.code_structure, { file_count: 0, content: '', pending_paths: ['private/Hidden.swift'] });
    assert.equal(pending.measurement.complete, false);
    const costs = (await client.inspect(draft.id, { view: 'costs', continuation: null, maxOutputBytes: 30000 }, new AbortController().signal));
    assert(costs.kind === 'costs'); assert.equal(costs.items.length, 3);
    const oneRecordBytes = Buffer.byteLength(JSON.stringify({ ...costs, items: costs.items.slice(0, 1), truncated: true,
      continuation: { digest: '0'.repeat(64), offset: 1 } }));
    const page = (await client.inspect(draft.id, { view: 'costs', continuation: null, maxOutputBytes: oneRecordBytes }, new AbortController().signal));
    assert(page.kind === 'costs'); assert(page.truncated); assert(page.continuation);
    const completed = await client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
      op: 'get', view: 'content', maxOutputBytes: 30000 })), signal());
    assert.equal(completed.revision, 1); assert(completed.blocks?.some(body => body.includes('ExplicitlyManaged')));
    await assert.rejects(async () => (await client.inspect(draft.id, { view: 'costs', continuation: page.continuation, maxOutputBytes: 30000 }, new AbortController().signal)), /staleContinuation/);
    const finalized = await client.finalize(draft.id, signal()); assert.equal(finalized.kind, 'ready');
    if (finalized.kind === 'ready') await verifyBundle(finalized.directory);
    await writeFile(join(f.base, 'codemap-deadline-receipt.json'), JSON.stringify({ pending, completed, finalized }, null, 2) + '\n');
  } finally { if (timer !== null) clearTimeout(timer); release(); await client.close(); await runtime.close(); }
});

test('stale codemap completion reports pending committed membership and a later get reacquires current presentation', async t => {
  await mkdir('test-output', { recursive: true });
  for (const scenario of ['source', 'mode', 'policy'] as const) await t.test(scenario, async () => {
    const f = await fixture(); await f.client.close();
    const path = join(f.root, 'private/Hidden.swift'), original = await readFile(path, 'utf8');
    const control = join(f.root, '.repo_ignore'), originalControl = await readFile(control, 'utf8');
    let armed = false, extractions = 0;
    class Runtime extends SmipRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
            const result = await super.request(operation, signal);
            if (armed && operation.kind === 'extract') {
              armed = false; extractions++;
              if (scenario === 'source') await writeFile(path, 'struct Replaced { let title: String }\n');
              else if (scenario === 'mode') await chmod(path, 0o755);
              else await writeFile(control, originalControl + 'zone/\n');
            }
            return result;
          }
        }
        return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
      }
    }
    const runtime = new Runtime({ cachePath: join(f.base, 'currentness-cache'), contextBudgetUnits: 200000, credentialPaths: [],
      nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
    const signal = () => new AbortController().signal;
    const client = runtime.createClient(null);
    try {
      const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.output }, signal());
      const draft = await client.createDraft(workspace.id, { task: 'Inspect', initialSelection: { codemapMode: 'automatic', sources: [] },
        duplicateUserInstructionsAtTop: false, copyPreset: 'standard', storedPrompts: [], constraints: '', enhancementMode: 'preserve',
        purpose: 'investigation', requiredSources: [], documents: [], patches: [], budgetUnits: 100000, discoveryHints: [], outputName: 'currentness' }, signal());
      armed = true;
      const pending = await client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
        op: 'set', mode: 'codemap_only', paths: [path], view: 'content', maxOutputBytes: 30000 })), signal());
      assert.equal(pending.revision, 1); assert.deepEqual(pending.files, []); assert.deepEqual(pending.blocks, []);
      assert.deepEqual(pending.code_structure, { file_count: 0, content: '', pending_paths: ['private/Hidden.swift'] });
      assert.equal(pending.measurement.complete, false);
      await writeFile(path, original); await chmod(path, 0o644); await writeFile(control, originalControl);
      const completed = await client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
        op: 'get', view: 'content', maxOutputBytes: 30000 })), signal());
      assert.equal(completed.revision, 1); assert(completed.blocks?.some(body => body.includes('ExplicitlyManaged')));
      assert.equal(extractions, 1);
      const finalized = await client.finalize(draft.id, signal()); assert.equal(finalized.kind, 'ready');
      if (finalized.kind === 'ready') { await verifyBundle(finalized.directory); await verifyCurrentBundle(finalized.directory, runtime, signal()); }
      await writeFile(join('test-output', 'codemap-currentness-' + scenario + '-proof.json'), JSON.stringify({ scenario, pending, completed, finalized, extractions }, null, 2) + '\n');
    } finally { await client.close(); await runtime.close(); }
  });
});
