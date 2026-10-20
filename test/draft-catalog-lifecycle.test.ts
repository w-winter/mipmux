import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MipmuxRuntime, verifyBundle } from '../src/index.js';
import type { ContextBuildRequest } from '../src/contracts/context.js';
import { readValidator, searchValidator, treeValidator } from '../src/contracts/exploration.js';
import { selectionValidator } from '../src/contracts/selection.js';
import { scopedCall } from '../src/discovery/scoped-tools.js';
import { identityEncoding } from '../src/exploration/output-budget.js';

const signal = () => new AbortController().signal;
const search = searchValidator.Parse(searchValidator.Default({ mode: 'content', query: { kind: 'literal', text: 'needle' }, maxOutputBytes: 100000 }));
const read = readValidator.Parse(readValidator.Default({ root: 'r', path: 'new.ts', maxOutputBytes: 100000 }));
const request: ContextBuildRequest = { task: 'Inspect current source', budgetUnits: 100000, outputName: 'packet',
  initialSelection: { codemapMode: 'manual', sources: [] }, requiredSources: [{ kind: 'full', source: { root: 'r', path: 'old.ts' } }],
  duplicateUserInstructionsAtTop: false, copyPreset: 'standard', constraints: '',
  enhancementMode: 'preserve', purpose: 'investigation', documents: [], patches: [], discoveryHints: [] };

for (const mutation of ['selection', 'update'] as const) test(`draft ${mutation} uses the reconciled catalog without replacing captured evidence`, async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-draft-catalog-'));
  const root = join(base, 'root'), output = join(base, 'out'); await mkdir(root); await mkdir(output);
  await writeFile(join(root, 'old.ts'), 'export const old = "needle old";\n');
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 1000000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {},
    credentialPaths: [], terminationGraceMs: 100 });
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, signal());
    const draft = await workspace.createDraft(request, signal());
    const pinned = await draft.operation.fork(signal());
    try {
      await writeFile(join(root, 'new.ts'), 'export const added = "needle new";\n');
      const found = await draft.operation.fileSearch(search);
      assert(found.kind === 'search');
      assert(found.files.some(file => file.path === 'new.ts'));
      const readBack = await scopedCall({ name: 'read_file', input: read }, draft, draft.operation, signal(), identityEncoding);
      const directRead = await draft.operation.readFile(read);
      assert(directRead.kind === 'read');
      assert.equal(directRead.content, 'export const added = "needle new";\n');
      await assert.rejects(pinned.readSource({ root: 'r', path: 'new.ts' }), { code: 'unavailableSource' });
      const current = await draft.operation.fork(signal());
      try { assert.equal((await current.readSource({ root: 'r', path: 'new.ts' })).text, 'export const added = "needle new";\n'); }
      finally { await current.close(); }
      const tree = await draft.operation.getFileTree(treeValidator.Parse(treeValidator.Default({ type: 'files', mode: 'full', selection: null, maxOutputBytes: 100000 })));
      assert(tree.kind === 'tree');
      assert.match(tree.tree, /new\.ts/);
      let changed: unknown;
      if (mutation === 'selection') {
        changed = await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'add', paths: ['r/new.ts'], mode: 'full', maxOutputBytes: 100000 })), signal());
      } else {
        const preview = await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({
          op: 'preview', paths: ['r/old.ts', 'r/new.ts'], maxOutputBytes: 100000 })), signal());
        assert(preview.files.some(file => file.path.includes('new.ts')));
        changed = await draft.update({ expectedRevision: draft.revision, maxOutputBytes: 100000,
          mutation: { kind: 'upsert', selection: { kind: 'full', source: { root: 'r', path: 'new.ts' } } } }, signal());
      }
      assert.match(await draft.initialContext(signal()), /new\.ts/);
      const validation = await draft.validate(signal());
      const result = await draft.finalize(signal());
      assert.equal(result.kind, 'ready', JSON.stringify(result));
      if (result.kind !== 'ready') assert.fail('Missing ready packet');
      assert(result.manifest.inventory.entries.some(entry => entry.path === 'new.ts'));
      assert(result.manifest.materials.some(record => record.kind === 'source' && record.selection.source.path === 'new.ts'));
      await verifyBundle(result.directory);
      const terminal = await draft.inspect({ view: 'costs', maxOutputBytes: 100000, continuation: null }, signal());
      assert(terminal.kind === 'costs');
      assert.equal(terminal.measurement.bytes, result.manifest.accounting.bytes);
      await mkdir('test-output', { recursive: true });
      await writeFile(`test-output/draft-catalog-${mutation}.json`, JSON.stringify({ found, readBack, tree, changed, validation, result, terminal }, null, 2) + '\n');
    } finally { await pinned.close(); await draft.close(); }
    await workspace.close();
  } finally { await runtime.close(); }
});

test('catalog reconciliation cannot refreeze required source evidence', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-draft-required-catalog-'));
  const root = join(base, 'root'), output = join(base, 'out'); await mkdir(root); await mkdir(output);
  await writeFile(join(root, 'required.txt'), 'needle original\n');
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 1000000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {},
    credentialPaths: [], terminationGraceMs: 100 });
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, signal());
    const draft = await workspace.createDraft({ ...request, requiredSources: [{ kind: 'full', source: { root: 'r', path: 'required.txt' } }] }, signal());
    try {
      await writeFile(join(root, 'required.txt'), 'needle replacement\n');
      const found = await draft.operation.fileSearch(search);
      assert(found.kind === 'search');
      assert.equal(found.counts.matchingLines, 1);
      await assert.rejects(draft.finalize(signal()), { code: 'sourceChanged' });
    } finally { await draft.close(); }
    await workspace.close();
  } finally { await runtime.close(); }
});

test('managed source refresh advances new operations without changing an admitted source identity', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-managed-catalog-'));
  const root = join(base, 'root'), output = join(base, 'out'); await mkdir(root); await mkdir(output);
  await writeFile(join(root, '.repo_ignore'), 'hidden.txt\n'); await writeFile(join(root, 'hidden.txt'), 'original\n');
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 1000000,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {},
    credentialPaths: [], terminationGraceMs: 100 });
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, signal());
    const pinned = await workspace.openOperation(signal()), source = { root: 'r', path: 'hidden.txt' };
    try {
      await pinned.registerExplicitSource(source);
      const original = await pinned.readSource(source);
      await writeFile(join(root, 'hidden.txt'), 'replacement\n'); await workspace.refresh(signal());
      await assert.rejects(pinned.readSource(source), { code: 'sourceChanged' });
      const current = await pinned.fork(signal());
      try { assert.equal((await current.readSource(source)).text, 'replacement\n'); }
      finally { await current.close(); }
      await mkdir('test-output', { recursive: true });
      await writeFile('test-output/managed-catalog-identity.json', JSON.stringify({ original: original.identity, current: 'replacement\n' }, null, 2) + '\n');
    } finally { await pinned.close(); }
    await workspace.close();
  } finally { await runtime.close(); }
});
