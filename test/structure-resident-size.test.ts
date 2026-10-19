import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { BridgeClient } from '../src/native/bridge-client.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import type { NativeStructureInput } from '../src/contracts/structure.js';

const uuid = (index: number) => `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`;
const residentNodeLimit = 100000;

test('a small structural output cannot bypass the source resident graph node limit', async () => {
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    env: {}, supervisor });
  const input: NativeStructureInput = { kind: 'queryStructure', inventoryDigest: 'a'.repeat(64), codeMapsGloballyDisabled: false,
    roots: [{ id: uuid(0), name: 'r', canonicalPath: '/fixture/r', complete: true, directories: [],
      files: Array.from({ length: residentNodeLimit + 1 }, (_, index) => ({ id: uuid(index + 1), path: index + '.swift',
        state: 'empty', definitions: [], references: [], signature: null })) }],
    seedInput: { kind: 'paths', selectors: [{ kind: 'file', root: 'r', path: '0.swift' }] },
    expand: 'none', depth: 1, signatures: false, size: 'small' };
  const proof: unknown[] = [];
  try {
    const rejected = (await bridge.request(input, new AbortController().signal)).result;
    assert.equal(rejected.reply.status, 'unavailable');
    assert.deepEqual(rejected.reply.roots[0]?.issues.map(issue => issue.code), ['graph_revoked']);
    assert.equal(rejected.reply.summary.nodes, 0); assert.equal(rejected.reply.summary.files, 0);
    proof.push(rejected);
    input.roots[0]!.files.pop();
    const admitted = (await bridge.request(input, new AbortController().signal)).result;
    assert.equal(admitted.reply.status, 'ok'); assert.equal(admitted.reply.summary.nodes, 1);
    proof.push(admitted);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/structure-resident-size-proof.json', JSON.stringify(proof, null, 2) + '\n');
  } finally { await bridge.close(); await supervisor.close(); }
});
