import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MipmuxRuntime } from '../src/runtime/mipmux-runtime.js';

test('real exploration preserves queries, Unicode paths, counts, context and digest-bound pages', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-exploration-'));
  await mkdir(join(base, 'root')); await mkdir(join(base, 'out'));
  const name = 'line\né.txt';
  await writeFile(join(base, 'root', name), '\uFEFFstart\r\né café\rneedle needle\nneedle\nlast');
  await writeFile(join(base, 'root/A.swift'), 'struct OwnerRecord {\n let peer: PeerRecord\n let missing: MissingRecord\n}\n');
  await writeFile(join(base, 'root/B.swift'), 'struct PeerRecord {\n let owner: OwnerRecord\n}\n');
  await writeFile(join(base, 'root/C.swift'), 'struct PeerRecord {\n let label: String\n}\n');
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } });
  try {
    const handle = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(base, 'root') }], exclusions: [], outputRoot: join(base, 'out') }, new AbortController().signal);
    const op = await handle.openOperation(new AbortController().signal);
    const query = { mode: 'content' as const, query: { kind: 'literal' as const, text: 'needle', caseSensitive: true, wholeWord: true },
      filters: { roots: [], paths: [], exclude: [], extensions: [] }, before: 1, after: 1,
      countOnly: false, maxResults: 50, maxOutputBytes: 10000, continuation: null };
    const result = await op.fileSearch(query);
    if (result.kind !== 'search') assert.fail('Missing search');
    assert.equal(result.counts.totalMatches, 2); assert.equal(result.counts.matchingLines, 2);
    assert.equal(result.counts.matchedFiles, 1);
    assert.equal(result.files[0]?.path, name);
    assert.deepEqual(result.files[0]?.lines.map(line => line.number), [2, 3, 4, 5]);
    const path = await op.fileSearch({ ...query, mode: 'path', query: { ...query.query, text: 'é.txt', wholeWord: false } });
    assert.equal(path.kind, 'search');
    if (path.kind === 'search') assert.equal(path.counts.matchedFiles, 1);
    const trimmed = await op.fileSearch({ ...query, query: { ...query.query, text: ' needle ' } });
    if (trimmed.kind !== 'search') assert.fail('Missing search');
    assert.equal(trimmed.counts.totalMatches, 2);
    const tree = await op.getFileTree({ type: 'files', mode: 'full', scope: null, maxDepth: null, selection: null, maxOutputBytes: 10000, continuation: null });
    assert.equal(tree.kind, 'tree');
    const structure = await op.getCodeStructure({ seeds: [{ root: 'r', path: 'A.swift', kind: 'file' }], expand: 'both', depth: 4,
      signatures: true, size: 'medium', maxOutputBytes: 10000, selection: null });
    if (structure.kind !== 'structure') assert.fail('Missing structure');
    assert.equal(structure.files.length, 3);
    assert(structure.roots[0]?.edges.some(edge => edge.symbols.includes('PeerRecord') && edge.ambiguous));
    assert(structure.roots[0]?.unresolved.some(item => item.name === 'MissingRecord' && item.reason === 'missing'));
    const unsupported = await op.getCodeStructure({ seeds: [{ root: 'r', path: name, kind: 'file' }], expand: 'none', depth: 1,
      signatures: true, size: 'medium', maxOutputBytes: 10000, selection: null });
    if (unsupported.kind !== 'structure') assert.fail('Missing unsupported structure');
    assert.equal(unsupported.status, 'unavailable');
    assert.equal(unsupported.roots[0]?.seeds[0]?.state, 'not_indexed');
    const selected = await op.getFileTree({ type: 'files', mode: 'selected', scope: null, maxDepth: null,
      selection: { draftId: 'caller-owned-selection', revision: 1, sources: [{ root: 'r', path: name }] },
      maxOutputBytes: 10000, continuation: null });
    if (selected.kind !== 'tree') assert.fail('Missing selected tree');
    assert.equal(selected.tree, 'r\n└── ' + name + ' *\n');
    await op.close(); await handle.close();
  } finally { await runtime.close(); }
});
