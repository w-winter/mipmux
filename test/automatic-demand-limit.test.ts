import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, type ContextBuildRequest, type DraftRuntime } from '../src/index.js';
import type { Continuation } from '../src/contracts/exploration.js';

const maximumCandidateDemandCount = 1024;
const signal = () => new AbortController().signal;

async function sourceCounts(draft: DraftRuntime) {
  let continuation: Continuation | null = null, inferred = 0, explicit = 0;
  do {
    const view = await draft.inspect({ view: 'metadata', maxOutputBytes: 1000000, continuation }, signal());
    assert.equal(view.kind, 'metadata'); assert(view.kind === 'metadata');
    for (const item of view.items) if ('kind' in item && item.kind === 'source') {
      if (item.selectionOrigin === 'inferred') inferred++; else explicit++;
    }
    continuation = view.continuation;
  } while (continuation);
  return { inferred, explicit };
}

test('automatic demand overflow clears only inferred codemaps and preserves source selection and Native-free verification', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-automatic-demand-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  await writeFile(join(root, 'Seed.swift'), 'struct Seed { let shared: SharedRecord }\n');
  await Promise.all(Array.from({ length: maximumCandidateDemandCount + 1 }, (_, index) =>
    writeFile(join(root, 'Peer' + index + '.swift'), 'struct SharedRecord { let value: Int }\n')));
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    terminationGraceMs: 100, nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {} });
  const proof: unknown[] = [];
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal());
    const request: ContextBuildRequest = { task: 'Inspect the implementation', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      initialSelection: { codemapMode: 'automatic', sources: [] }, requiredSources: [{ kind: 'full', source: { root: 'r', path: 'Seed.swift' } }],
      documents: [], patches: [], storedPrompts: [], copyPreset: 'standard', duplicateUserInstructionsAtTop: false,
      discoveryHints: [], budgetUnits: 200000, outputName: 'overflow' };
    for (const count of [maximumCandidateDemandCount + 1, maximumCandidateDemandCount]) {
      if (count === maximumCandidateDemandCount) await writeFile(join(root, 'Peer' + maximumCandidateDemandCount + '.swift'), 'struct OtherRecord {}\n');
      const draft = await workspace.createDraft({ ...request, outputName: 'targets-' + count }, signal());
      const { inferred, explicit } = await sourceCounts(draft);
      const expected = count > maximumCandidateDemandCount ? 0 : maximumCandidateDemandCount;
      assert.equal(inferred, expected); assert.equal(explicit, 1);
      assert.equal(draft.revision, 0);
      const finalized = await draft.finalize(signal()); assert.equal(finalized.kind, 'ready'); assert(finalized.kind === 'ready');
      const verified = await verifyBundle(finalized.directory);
      assert.equal(verified.manifest.materials.filter(material => material.kind === 'source' && material.selectionOrigin === 'inferred').length, expected);
      assert((await readFile(join(finalized.directory, 'context.md'), 'utf8')).includes('struct Seed'));
      proof.push({ count, expectedInferred: expected, finalized, verification: verified.kind });
    }
    await writeFile('test-output/automatic-demand-limit-proof.json', JSON.stringify(proof, null, 2) + '\n');
  } finally { await runtime.close(); }
});
