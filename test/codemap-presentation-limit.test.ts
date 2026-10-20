import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { MipmuxRuntime, verifyBundle } from '../src/index.js';
import { selectionValidator } from '../src/contracts/selection.js';

const referenceOutput = Compile(Type.Object({ directGuardCases: Type.Array(Type.Object({ name: Type.String(), requestCount: Type.Integer() })) }));

test('exact codemap presentation limits ready entries per root before rendering, preserving required selection', async () => {
  const reference = referenceOutput.Parse(JSON.parse(await readFile('test/fixtures/rpce-presentation-limit/expected.json', 'utf8')));
  const sourceEntryLimit = reference.directGuardCases.find(entry => entry.name === 'at-limit')!.requestCount;
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mipmux-presentation-limit-')));
  const root = join(base, 'source'), peer = join(base, 'peer'), output = join(base, 'out');
  await mkdir(root); await mkdir(peer); await mkdir(output);
  await writeFile(join(root, 'Required.swift'), 'struct Required { let value: Int }\n');
  await writeFile(join(root, 'Undecodable.swift'), Buffer.from('//4A2A==', 'base64'));
  await writeFile(join(peer, 'Healthy.swift'), 'struct Healthy { let value: Int }\n');
  for (let index = 0; index < sourceEntryLimit; index++) {
    await writeFile(join(root, 'Peer' + String(index).padStart(4, '0') + '.swift'), index === 0 ? '' : 'struct Peer { let value: Int }\n');
  }
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = new AbortController().signal, client = runtime.createClient(null);
  try {
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }, { name: 's', absolutePath: peer }],
      exclusions: [], outputRoot: output }, signal);
    const draft = await client.createDraft(workspace.id, { task: 'Inspect', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      initialSelection: { codemapMode: 'manual', sources: [] }, requiredSources: [{ kind: 'codemap', source: { root: 'r', path: 'Required.swift' } }],
      documents: [], patches: [], duplicateUserInstructionsAtTop: false, copyPreset: 'standard',
      budgetUnits: 200000, discoveryHints: [], outputName: 'presentation-limit' }, signal);
    const limited = await client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
      op: 'set', mode: 'codemap_only', paths: [root, peer], view: 'content', maxOutputBytes: 4 * 1024 * 1024,
    })), signal);
    assert.equal(limited.revision, 1);
    assert.equal(limited.measurement.complete, false);
    assert.equal(limited.code_structure?.pending_paths?.length, sourceEntryLimit + 1);
    assert(limited.code_structure?.pending_paths?.includes('r/Required.swift'));
    assert.deepEqual(limited.files.map(file => file.path), ['s/Healthy.swift']);
    assert.deepEqual(limited.code_structure?.unmapped_paths, ['r/Undecodable.swift']);
    const blocked = await client.finalize(draft.id, signal);
    assert.equal(blocked.kind, 'blocked');
    const recovered = await client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
      op: 'remove', mode: 'codemap_only', paths: ['r/Peer0000.swift'], view: 'content', maxOutputBytes: 4 * 1024 * 1024,
    })), signal);
    assert.equal(recovered.revision, 2);
    assert.equal(recovered.measurement.complete, true);
    assert.equal(recovered.code_structure?.pending_paths?.length ?? 0, 0);
    assert.deepEqual(recovered.code_structure?.unmapped_paths, ['r/Undecodable.swift']);
    assert.equal(recovered.files.length, sourceEntryLimit + 1);
    assert(recovered.files.some(file => file.path === 'r/Required.swift'));
    assert(recovered.files.some(file => file.path === 's/Healthy.swift'));
    const finalized = await client.finalize(draft.id, signal);
    assert.equal(finalized.kind, 'ready');
    if (finalized.kind === 'ready') await verifyBundle(finalized.directory);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/codemap-presentation-limit-proof.json', JSON.stringify({ sourceEntryLimit, limited, blocked, recovered, finalized }, null, 2) + '\n');
  } finally { await client.close(); await runtime.close(); }
});
