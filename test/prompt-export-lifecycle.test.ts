import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { MipmuxRuntime, verifyBundle, verifyCurrentBundle, type ContextBuildRequest } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { copyContext } from './fixtures/copy-context.js';

const signal = () => new AbortController().signal;
const request: ContextBuildRequest = { task: 'CAPTURED PROMPT', constraints: '', purpose: 'investigation', enhancementMode: 'fullRewrite',
  initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'r', path: 'Source.swift' } }] },
  requiredSources: [], documents: [], patches: [], duplicateUserInstructionsAtTop: false,
  copyPreset: 'standard', budgetUnits: 200000, discoveryHints: [], outputName: 'packet' };

async function fixture(before: (operation: NativeOperation) => Promise<void>, after: (operation: NativeOperation) => Promise<void>, settings = copyContext()) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mipmux-export-lifecycle-'))), root = join(base, 'source'), output = join(base, 'out');
  await mkdir(root); await mkdir(output); await writeFile(join(root, 'Source.swift'), 'struct Source { let value: Int }\n');
  class Runtime extends MipmuxRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          await before(operation);
          const result = await super.request(operation, signal);
          await after(operation);
          return result;
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, supervisor: this.supervisor, env: this.options.nativeEnvironment });
    }
  }
  const runtime = new Runtime({ copyContext: settings, cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000 });
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] }, signal());
  return { base, root, output, runtime, workspace };
}

for (const phase of ['assembly', 'beforeWrite', 'afterWrite'] as const) test(`prompt export cancellation at ${phase} settles owned work and retains an editable draft`, async () => {
  const controller = new AbortController(); let armed = false, writes = 0;
  const f = await fixture(async operation => {
    if (armed && phase === 'assembly' && operation.kind === 'renderPreparedClipboard') controller.abort();
    if (armed && phase === 'beforeWrite' && operation.kind === 'openRoots' && operation.roots.some(root => root.name === 'output')) controller.abort();
  }, async operation => {
    if (operation.kind === 'writePromptExport') { writes++; if (phase === 'afterWrite') controller.abort(); }
  });
  try {
    const draft = await f.workspace.createDraft(request, signal()); armed = true;
    const projection = draft.selectionProjection();
    await assert.rejects(draft.prompt({ op: 'export', path: 'cancel.md', maxOutputBytes: 100000 }, controller.signal), /abort|cancel/i);
    armed = false;
    assert.equal(writes, phase === 'afterWrite' ? 1 : 0);
    if (phase === 'afterWrite') assert((await readFile(join(f.output, 'cancel.md'), 'utf8')).includes('CAPTURED PROMPT'));
    else await assert.rejects(readFile(join(f.output, 'cancel.md')), /ENOENT/);
    assert.deepEqual((await readdir(f.output)).filter(name => name.startsWith('.snapshot-')), []);
    assert.equal(draft.revision, 0); assert.deepEqual(draft.selectionProjection(), projection);
    await draft.prompt({ op: 'append', text: '\nAFTER CANCEL', expectedRevision: 0, maxOutputBytes: 100000 }, signal());
    const final = await draft.finalize(signal()); assert.equal(final.kind, 'ready');
    await mkdir('test-output', { recursive: true });
    await writeFile(`test-output/prompt-export-cancel-${phase}.json`, JSON.stringify({ phase, writes, final }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});

test('an export captures one prompt and selection revision while a later mutation commits', async () => {
  let entered!: () => void, release!: () => void, armed = false;
  const entering = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async operation => {
    if (armed && operation.kind === 'renderPreparedClipboard') { armed = false; entered(); await held; }
  }, async () => {});
  try {
    const draft = await f.workspace.createDraft(request, signal()), original = draft.selectionProjection();
    armed = true;
    const exporting = draft.prompt({ op: 'export', path: 'captured.md', maxOutputBytes: 100000 }, signal());
    await Promise.race([entering, exporting.then(() => { throw new Error('Assembly was not held'); })]);
    await draft.prompt({ expectedRevision: 0, maxOutputBytes: 100000, op: 'set', text: 'LATER PROMPT'  }, signal());
    await draft.update({ expectedRevision: 1, maxOutputBytes: 100000, mutation: { kind: 'clearSources' } }, signal());
    release(); await exporting;
    const body = await readFile(join(f.output, 'captured.md'), 'utf8');
    assert(body.includes('CAPTURED PROMPT')); assert(body.includes('struct Source')); assert(!body.includes('LATER PROMPT'));
    assert.equal(draft.revision, 2); assert.notDeepEqual(draft.selectionProjection(), original);
    const final = await draft.finalize(signal()); assert(final.kind === 'ready');
    const finalBody = await readFile(join(final.directory, 'context.md'), 'utf8');
    assert(finalBody.includes('LATER PROMPT')); assert(!finalBody.includes('struct Source'));
    await verifyBundle(final.directory); await verifyCurrentBundle(final.directory, f.runtime, signal());
  } finally { release(); await f.runtime.close(); }
});

test('custom presets use captured current settings but ignore Manual working-copy customizations', async () => {
  const settings = copyContext(); settings.current.fileTreeMode = 'None'; settings.current.codeMapUsage = 'selected';
  settings.customizations.includeFiles = false; settings.customizations.includeUserPrompt = false;
  settings.customizations.fileTreeMode = 'Full'; settings.customizations.codeMapUsage = 'none';
  settings.presets.push({ id: 'ABCDEFAB-1234-1234-1234-ABCDEFABCDEF', name: 'Café custom', builtInKind: null,
    description: null, icon: null, notes: null, isBuiltIn: false, includeFiles: null, includeUserPrompt: null,
    includeFileTree: null, fileTreeMode: null, codeMapUsage: null, gitInclusion: null });
  const f = await fixture(async () => {}, async () => {}, settings);
  try {
    const draft = await f.workspace.createDraft({ ...request, copyPreset: { name: 'Cafe\u0301 custom' } }, signal());
    settings.current.codeMapUsage = 'none'; settings.current.fileTreeMode = 'Full'; settings.presets.length = 0;
    await draft.prompt({ op: 'export', path: 'custom.md', maxOutputBytes: 100000 }, signal());
    const body = await readFile(join(f.output, 'custom.md'), 'utf8');
    assert(body.includes('CAPTURED PROMPT')); assert(body.includes('File: r/Source.swift')); assert(!body.includes('<file_contents>'));
    const final = await draft.finalize(signal()); assert(final.kind === 'ready');
    assert.equal(final.manifest.clipboardPreset.codeMapUsage, 'selected'); assert.equal(final.manifest.clipboardPreset.gitInclusion, 'none');
    assert.equal(body, await readFile(join(final.directory, 'context.md'), 'utf8'));
    await verifyBundle(final.directory); await verifyCurrentBundle(final.directory, f.runtime, signal());
  } finally { await f.runtime.close(); }
});

test('an explicitly configured custom preset named Plan resolves independently of the removed built-in', async () => {
  const settings = copyContext(), customID = 'abcdefab-1234-1234-1234-abcdefabcdef';
  settings.current.fileTreeMode = 'None'; settings.current.codeMapUsage = 'none';
  settings.presets.push({ id: customID, name: 'Plan', builtInKind: null, isBuiltIn: false,
    description: null, icon: null, notes: null, includeFiles: true, includeUserPrompt: false,
    includeFileTree: false, fileTreeMode: null, codeMapUsage: null,
    gitInclusion: null });
  const f = await fixture(async () => {}, async () => {}, settings);
  try {
    const draft = await f.workspace.createDraft(request, signal());
    const exported = await draft.prompt({ op: 'export', path: 'named-plan.md', copy_preset: { name: 'Plan' }, maxOutputBytes: 100000 }, signal());
    assert(exported.op === 'export');
    assert.equal(exported.export.copy_preset.id.toLowerCase(), customID);
    const body = await readFile(join(f.output, 'named-plan.md'), 'utf8');
    assert(body.includes('struct Source')); assert(!body.includes('CAPTURED PROMPT'));
  } finally { await f.runtime.close(); }
});

test('export refuses over-budget and required-material conflicts before writing', async () => {
  const f = await fixture(async () => {}, async () => {});
  try {
    const draft = await f.workspace.createDraft({ ...request, requiredSources: request.initialSelection.sources }, signal());
    await assert.rejects(draft.prompt({ op: 'export', path: 'excluded.md', copy_preset: 'diffFollowUp', maxOutputBytes: 100000 }, signal()), /copyPresetRequiredMaterialConflict/);
    await assert.rejects(readFile(join(f.output, 'excluded.md')), /ENOENT/);
    const oversized = await f.workspace.createDraft({ ...request, budgetUnits: 1, outputName: 'oversized' }, signal());
    await assert.rejects(oversized.prompt({ op: 'export', path: 'oversized.md', maxOutputBytes: 100000 }, signal()), /promptExportBlocked/);
    await assert.rejects(readFile(join(f.output, 'oversized.md')), /ENOENT/);
    assert.equal(oversized.revision, 0);
  } finally { await f.runtime.close(); }
});

for (const replaced of ['parent', 'root'] as const) test(`prompt export rejects ${replaced} replacement during native writing`, async () => {
  const f = await fixture(async () => {}, async () => {}), bridge = f.runtime.makeBridge();
  const parent = join(f.output, 'sub'), moved = join(f.base, 'moved-output'), destination = join(parent, 'packet.md');
  await mkdir(parent);
  // The payload makes the native temporary-file write observable without changing the operator budget.
  const payloadBytes = 8 * 1024 * 1024, bytes = Buffer.alloc(payloadBytes, 0x41);
  let changed!: () => void, failed!: (reason: Error) => void;
  const mutation = new Promise<void>((resolve, reject) => { changed = resolve; failed = reject; });
  let observed: { temporaryBytes: number; destinationExisted: boolean } | null = null;
  try {
    const opened = await bridge.request({ kind: 'openRoots', roots: [{ name: 'out', absolutePath: f.output,
      access: 'output', expected: null }] }, signal());
    const output = opened.result.roots[0]; assert(output);
    const temporaryObservationIntervalMs = 1;
    const observer = setInterval(() => {
      if (observed !== null) return;
      try {
        const filename = readdirSync(parent).find(name => name.startsWith('.snapshot-'));
        if (filename === undefined) return;
        observed = { temporaryBytes: statSync(join(parent, filename)).size, destinationExisted: existsSync(destination) };
        assert.equal(observed.destinationExisted, false);
        const target = replaced === 'parent' ? parent : f.output;
        renameSync(target, moved); mkdirSync(target);
        if (replaced === 'root') mkdirSync(parent);
        changed();
      } catch (error) { assert(error instanceof Error); failed(error); }
    }, temporaryObservationIntervalMs);
    try {
      const writing = bridge.request({ kind: 'writePromptExport', root: output.handle, path: 'sub/packet.md', bytes: bytes.toString('base64') }, signal());
      const completed = writing.then(() => false, () => false);
      assert.equal(await Promise.race([mutation.then(() => true), completed]), true, 'Replacement must precede native acknowledgement');
      await assert.rejects(writing, replaced === 'parent' ? /outputChanged/ : /rootChanged/);
      assert(observed);
      await assert.rejects(readFile(destination), { code: 'ENOENT' });
      const movedDestination = replaced === 'parent' ? join(moved, 'packet.md') : join(moved, 'sub/packet.md');
      assert((await readFile(movedDestination)).equals(bytes));
      await mkdir('test-output', { recursive: true });
      await writeFile(`test-output/prompt-export-${replaced}-replacement.json`, JSON.stringify({ replaced, observed,
        payloadBytes, acknowledged: false, completedBytesRetained: true }, null, 2) + '\n');
    } finally { clearInterval(observer); }
  } finally { await bridge.close(); await f.runtime.close(); }
});
