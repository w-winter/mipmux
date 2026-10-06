import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';

test('real exploration preserves queries, Unicode paths, counts, context and digest-bound pages', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(resolve('test-output/exploration-'));
  await mkdir(join(base, 'root')); await mkdir(join(base, 'out'));
  const name = 'line\né.txt';
  await writeFile(join(base, 'root', name), '\uFEFFstart\r\né café\rneedle needle\nneedle\nlast');
  await writeFile(join(base, 'root/A.swift'), 'struct OwnerRecord {\n let peer: PeerRecord\n let missing: MissingRecord\n}\n');
  await writeFile(join(base, 'root/B.swift'), 'struct PeerRecord {\n let owner: OwnerRecord\n}\n');
  await writeFile(join(base, 'root/C.swift'), 'struct PeerRecord {\n let label: String\n}\n');
  const executable = process.env.SMIP_TEST_RG ?? resolve('.smip-work/test-ripgrep/ripgrep-e89fff89ac9af12e8d4ce9d5fd07beb408ca730f/target/release/rg');
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'), terminationGraceMs: 100, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' },
    search: { executable } });
  try {
    const handle = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(base, 'root') }], exclusions: [], outputRoot: join(base, 'out') }, new AbortController().signal);
    const op = await handle.openOperation(new AbortController().signal);
    const query = { mode: 'content' as const, query: { kind: 'literal' as const, text: 'needle', caseSensitive: true, wholeWord: true },
      filters: { roots: [], directories: [], include: [], exclude: [], extensions: [] }, before: 1, after: 1,
      countOnly: false, maxOutputBytes: 10000, continuation: null };
    const result = await op.fileSearch(query);
    if (result.kind !== 'search') assert.fail('Missing search');
    assert.equal(result.counts.occurrences, 3); assert.equal(result.counts.matchingLines, 2);
    assert.equal(result.counts.matchedFiles, 1);
    assert.equal(result.files[0]?.path, name);
    assert.deepEqual(result.files[0]?.lines.map(line => line.number), [2, 3, 4, 5]);
    const path = await op.fileSearch({ ...query, mode: 'path', query: { ...query.query, text: 'é.txt', wholeWord: false } });
    assert.equal(path.kind, 'search');
    if (path.kind === 'search') assert.equal(path.counts.matchedFiles, 1);
    const empty = await op.fileSearch({ ...query, query: { ...query.query, text: ' needle ' } });
    if (empty.kind !== 'search') assert.fail('Missing search');
    assert.equal(empty.counts.occurrences, 0);
    const tree = op.getFileTree({ view: 'files', depth: null, selection: null, maxOutputBytes: 10000, continuation: null });
    assert.equal(tree.kind, 'tree');
    const structure = op.getCodeStructure({ seeds: [{ root: 'r', path: 'A.swift', kind: 'file' }], expand: 'both', depth: 4,
      maxOutputBytes: 10000, continuation: null });
    assert.equal(structure.kind, 'structure');
    if (structure.kind === 'structure') {
      assert.equal(structure.approximate, true); assert.equal(structure.files.length, 3);
      for (const file of structure.files) for (const relationship of file.relationships) {
        assert.equal(relationship.root, file.root); assert.equal(relationship.from, file.path);
      }
      const evidence = structure.files.flatMap(file => file.relationships);
      assert(evidence.some(item => item.type === 'PeerRecord' && item.candidates.length === 2));
      assert(evidence.some(item => item.type === 'MissingRecord' && item.candidates.length === 0));
    }
    const unsupported = op.getCodeStructure({ seeds: [{ root: 'r', path: name, kind: 'file' }], expand: 'none', depth: 1,
      maxOutputBytes: 10000, continuation: null });
    if (unsupported.kind !== 'structure') assert.fail('Missing unsupported structure');
    assert.equal(unsupported.files[0]?.outcome.kind, 'unsupported');
    const selected = op.getFileTree({ view: 'selected', depth: null,
      selection: { draftId: 'caller-owned-selection', revision: 1, sources: [{ root: 'r', path: name }] },
      maxOutputBytes: 10000, continuation: null });
    if (selected.kind !== 'tree') assert.fail('Missing selected tree');
    assert.deepEqual(selected.entries.map(entry => entry.path), [name]);
    await op.close(); await handle.close();
  } finally { await runtime.close(); }
});
