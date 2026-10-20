import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime } from '../src/index.js';
import { readValidator } from '../src/contracts/exploration.js';
import { selectionValidator } from '../src/contracts/selection.js';

test('a replaced root does not prevent scoped reads from an independent admitted root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smip-root-scope-'));
  const first = join(directory, 'first'), second = join(directory, 'second'), output = join(directory, 'out');
  for (const path of [first, second, output]) await mkdir(path);
  await writeFile(join(first, 'note.txt'), 'Original first root\n');
  await writeFile(join(second, 'note.txt'), 'Healthy second root\n');
  for (const root of [first, second]) await writeFile(join(root, 'model.swift'), 'struct Model { let value: Int }\n');
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(directory, 'cache'), contextBudgetUnits: 100000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = () => new AbortController().signal;
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: first }, { name: 's', absolutePath: second }],
    outputRoot: output, exclusions: [] }, signal());
  const operation = await workspace.openOperation(signal());
  try {
    const create = (root: string, codemapMode: 'automatic' | 'manual', kind: 'full' | 'codemap') => workspace.createDraft({ task: 'Inspect root authority',
      initialSelection: { codemapMode, sources: [] }, duplicateUserInstructionsAtTop: false,
      copyPreset: 'standard', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      requiredSources: [{ kind, source: { root, path: kind === 'full' ? 'note.txt' : 'model.swift' } }], documents: [], patches: [],
      discoveryHints: [], outputName: 'packet-' + root, budgetUnits: 100000 }, signal());
    const replacedDraft = await create('r', 'automatic', 'full'), healthyDraft = await create('s', 'automatic', 'full');
    const replacedManual = await create('r', 'manual', 'full'), healthyManual = await create('s', 'manual', 'full');
    const replacedCodemap = await create('r', 'manual', 'codemap'), healthyCodemap = await create('s', 'manual', 'codemap');
    await rename(first, first + '.original'); await mkdir(first);
    await writeFile(join(first, 'note.txt'), 'Unauthorized replacement root\n');
    const healthy = await operation.readSource({ root: 's', path: 'note.txt' });
    assert.equal(healthy.text, 'Healthy second root\n');
    await assert.rejects(operation.readSource({ root: 'r', path: 'note.txt' }), /rootChanged/);
    const reply = await operation.readFile(readValidator.Parse(readValidator.Default({ root: 's', path: 'note.txt', maxOutputBytes: 30000 })));
    assert.equal(reply.kind, 'read'); assert(JSON.stringify(reply).includes('Healthy second root'));
    const request = selectionValidator.Parse(selectionValidator.Default({ op: 'get', maxOutputBytes: 30000 }));
    const selected = await healthyDraft.manageSelection(request, signal()); assert.equal(selected.files.length, 1);
    const unavailable = await replacedDraft.manageSelection(request, signal());
    assert.equal(unavailable.files[0]?.tokens, 0);
    assert.equal(unavailable.unavailable_sources[0]?.code, 'rootChanged');
    const manual = await healthyManual.manageSelection(request, signal()); assert.equal(manual.files.length, 1);
    const unavailableManual = await replacedManual.manageSelection(request, signal());
    assert.equal(unavailableManual.files[0]?.tokens, 0);
    assert.equal(unavailableManual.measurement.complete, false);
    const codemap = await healthyCodemap.manageSelection(request, signal()); assert.equal(codemap.files.length, 1);
    const unavailableCodemap = await replacedCodemap.manageSelection(request, signal());
    assert.deepEqual(unavailableCodemap.files, []);
    assert.equal(unavailableCodemap.unavailable_sources[0]?.required, true);
    await assert.rejects(operation.validateRoots(), /rootChanged/);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/root-scoped-access-proof.json', JSON.stringify({ healthy: healthy.identity, reply, selected, manual, codemap,
      unavailable, unavailableManual, unavailableCodemap, replacementDenied: true }, null, 2) + '\n');
  } finally { await operation.close(); await workspace.close(); await runtime.close(); }
});
