import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeStructureInput, NativeStructureResult } from '../src/contracts/native.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';

const fixturesValidator = Compile(Type.Array(Type.Object({ name: Type.String(),
  input: NativeStructureInput, expected: NativeStructureResult })));

test('native structural queries preserve RPCE traversal, size, signature and unavailable evidence', async () => {
  const fixtures = fixturesValidator.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-structure/cases.json'), 'utf8')));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    env: {}, supervisor });
  const proof: string[] = [];
  try {
    for (const fixture of fixtures) {
      const reply = await bridge.request(fixture.input, new AbortController().signal);
      assert.deepEqual(reply.result, fixture.expected, fixture.name);
      proof.push(fixture.name);
    }
    await mkdir('test-output', { recursive: true });
    await writeFile(resolve('test-output/reference-structure-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  } finally { await bridge.close(); await supervisor.close(); }
});

test('native folder seed admission keeps direct-file priority and RPCE overflow sentinel independently of graph size', async () => {
  const uuid = (index: number) => `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`;
  const input = Compile(NativeStructureInput).Parse({ kind: 'queryStructure', inventoryDigest: 'a'.repeat(64), codeMapsGloballyDisabled: false,
    roots: [{ id: uuid(90000), name: 'r', canonicalPath: '/fixture/r', complete: true, directories: ['bulk'],
      files: Array.from({ length: 8194 }, (_, index) => ({ id: uuid(index + 1),
        path: `bulk/${String(index).padStart(5, '0')}.swift`, state: 'empty', definitions: [], references: [], signature: null })) }],
    seedInput: { kind: 'paths', selectors: [{ kind: 'directory', root: 'r', path: 'bulk' },
      { kind: 'file', root: 'r', path: 'bulk/08193.swift' }] },
    expand: 'none', depth: 1, signatures: false, size: 'small' });
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    env: {}, supervisor });
  try {
    const { result } = await bridge.request(input, new AbortController().signal);
    assert.equal(result.reply.summary.seeds, 8193);
    assert.equal(result.reply.summary.nodes, 40);
    assert(result.reply.roots[0]?.seeds.some(seed => seed.path === 'r/bulk/08193.swift'));
    assert(!result.reply.roots[0]?.seeds.some(seed => seed.path === 'r/bulk/08192.swift'));
    await mkdir('test-output', { recursive: true });
    await writeFile(resolve('test-output/structure-seed-limit-proof.json'), JSON.stringify(result.reply, null, 2) + '\n');
  } finally { await bridge.close(); await supervisor.close(); }
});
