import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { selectionValidator } from '../src/contracts/selection.js';

test('automatic selection reports source coverage while retaining useful targets from another root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-auto-source-coverage-'));
  const first = join(base, 'first'), second = join(base, 'second'), output = join(base, 'out');
  for (const path of [first, second, output]) await mkdir(path);
  await writeFile(join(first, 'Empty.swift'), '');
  await writeFile(join(first, 'Note.txt'), 'Selected source text\n');
  await writeFile(join(first, 'Peer.swift'), 'struct Peer { let value: Int }\n');
  await writeFile(join(second, 'Seed.swift'), 'struct Seed { let value: Peer }\n');
  await writeFile(join(second, 'Peer.swift'), 'struct Peer { let value: Int }\n');
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 100000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = () => new AbortController().signal;
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: first }, { name: 's', absolutePath: second }],
      outputRoot: output, exclusions: [] }, signal());
    const draft = await workspace.createDraft({ task: 'Inspect source coverage', initialSelection: { codemapMode: 'automatic', sources: [] },
      duplicateUserInstructionsAtTop: false, copyPreset: 'standard', storedPrompts: [], constraints: '', enhancementMode: 'preserve',
      purpose: 'investigation', requiredSources: [], documents: [], patches: [], discoveryHints: [], outputName: 'packet', budgetUnits: 100000 }, signal());
    const select = (paths: string[]) => draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({
      op: 'set', paths, view: 'files', maxOutputBytes: 100000 })), signal());
    const empty = await select(['r/Empty.swift']);
    assert.equal(empty.code_structure, undefined);
    const unsupported = await select(['r/Note.txt', 's/Seed.swift']);
    assert.deepEqual(unsupported.code_structure?.unmapped_paths, ['r/Note.txt']);
    assert(unsupported.files.some(file => file.path === 's/Peer.swift'));
    const newPath = join(first, 'New.swift');
    await writeFile(newPath, 'struct New { let value: Peer }\n');
    const pending = await select([newPath, 's/Seed.swift']);
    assert.deepEqual(pending.code_structure?.pending_paths, ['r/New.swift']);
    assert(pending.files.some(file => file.path === 'r/New.swift'));
    assert(pending.files.some(file => file.path === 's/Peer.swift'));
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, runtime, signal());
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/automatic-source-coverage-proof.json', JSON.stringify({ empty, unsupported, pending, ready }, null, 2) + '\n');
  } finally { await runtime.close(); }
});
