import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { StructureIndex } from '../src/workspace/structure-index.js';
import { structuralFile, structuralRoots } from './fixtures/structural-inventory.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SmipRuntime, verifyBundle } from '../src/index.js';
import { selectionValidator } from '../src/contracts/selection.js';

test('automatic source and root limits reject the whole input before target demand', () => {
  const seeds = Array.from({ length: 4096 }, (_, index) => structuralFile('r', 'Seed' + index + '.swift', [], ['Peer']));
  const extra = structuralFile('r', 'Extra.swift', [], ['Peer']);
  const peer = structuralFile('r', 'Peer.swift', ['Peer'], []);
  const snapshot = { roots: structuralRoots('r'), entries: [...seeds, extra, peer] };
  const index = new StructureIndex(snapshot);
  assert.equal(index.resolveAutomaticCodemapTargets(seeds).targets.length, 1);
  assert.deepEqual(index.resolveAutomaticCodemapTargets([...seeds, extra]), {
    kind: 'queryBudget', targets: [], rejections: [{ kind: 'sourceLimit', attempted: 4097, limit: 4096 }],
    coverage: { status: 'unavailable', sourceIssues: [] },
  });
  for (const count of [64, 65]) {
    const names = Array.from({ length: count }, (_, index) => 'r' + index);
    const seeds = names.map(root => structuralFile(root, 'Seed.swift', ['Seed'], ['Peer']));
    const peers = names.map(root => structuralFile(root, 'Peer.swift', ['Peer'], []));
    const snapshot = { roots: structuralRoots(...names), entries: [...seeds, ...peers] };
    const result = new StructureIndex(snapshot).resolveAutomaticCodemapTargets(seeds);
    if (count === 64) assert.equal(result.targets.length, count);
    else assert.deepEqual(result, { kind: 'queryBudget', targets: [],
      rejections: [{ kind: 'rootLimit', attempted: 65, limit: 64 }], coverage: { status: 'unavailable', sourceIssues: [] } });
  }
});

test('resolution budgets count distinct source-to-target edges rather than globally unique names', () => {
  const seeds = Array.from({ length: 1000 }, (_, index) => structuralFile('r', 'Seed' + index + '.swift', [], ['Peer', 'OtherName']));
  for (const count of [100, 101]) {
    const peers = Array.from({ length: count }, (_, index) => structuralFile('r', 'Peer' + index + '.swift', ['Peer', 'OtherName'], []));
    const snapshot = { roots: structuralRoots('r'), entries: [...seeds, ...peers] };
    const result = new StructureIndex(snapshot).resolveAutomaticCodemapTargets(seeds);
    if (count === 100) assert.equal(result.targets.length, count);
    else assert.deepEqual(result, { kind: 'queryBudget', targets: [], rejections: [
      { kind: 'resolutionLimit', root: 'r', attempted: 101000, limit: 100000 },
    ], coverage: { status: 'unavailable', sourceIssues: [] } });
  }
});

test('unresolved-reference budgets count each source while suppressing duplicate references within that source', () => {
  for (const count of [100, 101]) {
    const missing = Array.from({ length: count }, (_, index) => 'Missing' + index);
    const seeds = Array.from({ length: 1000 }, (_, index) => structuralFile('r', 'Seed' + index + '.swift', [],
      ['Peer', ...missing, ...missing]));
    const peer = structuralFile('r', 'Peer.swift', ['Peer'], []);
    const snapshot = { roots: structuralRoots('r'), entries: [...seeds, peer] };
    const result = new StructureIndex(snapshot).resolveAutomaticCodemapTargets(seeds);
    if (count === 100) assert.deepEqual(result.targets, [peer]);
    else assert.deepEqual(result, { kind: 'queryBudget', targets: [], rejections: [
      { kind: 'referenceFailureLimit', root: 'r', attempted: 101000, limit: 100000 },
    ], coverage: { status: 'unavailable', sourceIssues: [] } });
  }
});

test('a refused root consumes no shared automatic query budget and another root remains usable', async () => {
  const seeds = Array.from({ length: 1000 }, (_, index) => structuralFile('r', 'Seed' + index + '.swift', [], ['Peer']));
  const peers = Array.from({ length: 101 }, (_, index) => structuralFile('r', 'Peer' + index + '.swift', ['Peer'], []));
  const otherSeed = structuralFile('s', 'Seed.swift', [], ['Other']);
  const other = structuralFile('s', 'Other.swift', ['Other'], []);
  const snapshot = { roots: structuralRoots('r', 's'), entries: [...seeds, ...peers, otherSeed, other] };
  const result = new StructureIndex(snapshot).resolveAutomaticCodemapTargets([...seeds, otherSeed]);
  assert.deepEqual(result.targets, [other]);
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/automatic-query-budget-proof.json', JSON.stringify(result, null, 2) + '\n');
});

test('shared query allocation uses root UUID order rather than root alias order', () => {
  const roots = structuralRoots('s', 'r');
  const seeds = Array.from({ length: 1000 }, (_, index) => structuralFile('s', 'Seed' + index + '.swift', [], ['Peer']));
  const peers = Array.from({ length: 100 }, (_, index) => structuralFile('s', 'Peer' + index + '.swift', ['Peer'], []));
  const otherSeed = structuralFile('r', 'Seed.swift', [], ['Other']);
  const other = structuralFile('r', 'Other.swift', ['Other'], []);
  const snapshot = { roots, entries: [...seeds, ...peers, otherSeed, other] };
  const result = new StructureIndex(snapshot).resolveAutomaticCodemapTargets([...seeds, otherSeed]);
  assert.deepEqual(result, { kind: 'queryBudget', targets: peers.slice().sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
    rejections: [{ kind: 'resolutionLimit', root: 'r', attempted: 1, limit: 0 }], coverage: { status: 'partial', sourceIssues: [] } });
});

test('source admission overflow preserves explicit files and a verifiable packet through the public workspace API', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-auto-source-budget-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  const sources = [{ kind: 'full' as const, source: { root: 'r', path: 'Seed.swift' } }];
  await writeFile(join(root, 'Seed.swift'), 'struct Seed { let value: Peer }\n');
  await writeFile(join(root, 'Peer.swift'), 'struct Peer { let value: Int }\n');
  for (let index = 0; index < 4096; index++) {
    const path = 'Note' + index + '.txt'; await writeFile(join(root, path), '');
    sources.push({ kind: 'full', source: { root: 'r', path } });
  }
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  try {
    const signal = new AbortController().signal;
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal);
    const draft = await workspace.createDraft({ task: 'Inspect the selected inputs', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      initialSelection: { codemapMode: 'automatic', sources: [] }, requiredSources: sources, documents: [], patches: [], storedPrompts: [],
      copyPreset: 'standard', duplicateUserInstructionsAtTop: false, budgetUnits: 200000, discoveryHints: [], outputName: 'packet' }, signal);
    const result = await draft.finalize(signal); assert.equal(result.kind, 'ready'); assert(result.kind === 'ready');
    const verified = await verifyBundle(result.directory);
    assert.equal(verified.manifest.materials.filter(material => material.kind === 'source' && material.selectionOrigin === 'inferred').length, 0);
    assert.equal(verified.manifest.materials.filter(material => material.kind === 'source' && material.selectionOrigin === 'explicit').length, 4097);
    await writeFile(join(root, '.repo_ignore'), 'Note4095.txt\n');
    const ignored = await workspace.createDraft({ ...verified.manifest.request, requiredSources: [sources[0]!],
      initialSelection: { codemapMode: 'automatic', sources: sources.slice(0, -1) }, outputName: 'managed-only' }, signal);
    await ignored.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'add', mode: 'full',
      paths: [join(root, 'Note4095.txt')], maxOutputBytes: 10000000 })), signal);
    const ignoredResult = await ignored.finalize(signal); assert.equal(ignoredResult.kind, 'ready'); assert(ignoredResult.kind === 'ready');
    const ignoredVerified = await verifyBundle(ignoredResult.directory);
    assert.equal(ignoredVerified.manifest.materials.filter(material => material.kind === 'source' && material.selectionOrigin === 'inferred').length, 1);
    await writeFile('test-output/automatic-query-budget-public-proof.json', JSON.stringify(result, null, 2) + '\n');
  } finally { await runtime.close(); }
});
