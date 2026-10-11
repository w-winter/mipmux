import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeFileTreeInput, NativeFileTreeResult } from '../src/contracts/native.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';

const fixtureValidator = Compile(Type.Array(Type.Object({ name: Type.String(),
  input: NativeFileTreeInput,
  expected: NativeFileTreeResult,
})));

test('native file tree preserves original RPCE renderer outputs across modes, subtree depth and legends', async () => {
  const raw: unknown = JSON.parse(await readFile(resolve('test/fixtures/rpce-tree/cases.json'), 'utf8'));
  const fixtures = fixtureValidator.Parse(raw);
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    env: {}, supervisor });
  const proof: { name: string; bytes: number }[] = [];
  try {
    for (const fixture of fixtures) {
      assert.equal(fixture.input.kind, 'renderFileTree');
      const response = await bridge.request(fixture.input, new AbortController().signal);
      assert.deepEqual(response.result, fixture.expected, fixture.name);
      assert(response.result.kind === 'fileTree');
      proof.push({ name: fixture.name, bytes: Buffer.byteLength(response.result.tree) });
    }
    await writeFile(resolve('test-output/reference-tree-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  } finally { await bridge.close(); await supervisor.close(); }
});
