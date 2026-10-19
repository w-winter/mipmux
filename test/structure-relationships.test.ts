import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime } from '../src/index.js';

const structureReply = Compile(Type.Object({ kind: Type.Literal('structure'), roots: Type.Array(Type.Object({
  edges: Type.Array(Type.Object({ from: Type.String(), to: Type.String(), symbols: Type.Array(Type.String()) })),
  unresolved: Type.Array(Type.Object({ from: Type.String(), name: Type.String(), reason: Type.String() })),
})) }));

test('structural exploration preserves each source relationship when seeds share defined and unresolved names', async () => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'smip-structure-relationships-'));
  const root = join(directory, 'source'), output = join(directory, 'out');
  await mkdir(root); await mkdir(output);
  for (const name of ['A', 'B']) await writeFile(join(root, `${name}.swift`),
    `struct ${name}Record {\n let shared: SharedRecord\n let missing: MissingRecord\n}\n`);
  await writeFile(join(root, 'Shared.swift'), 'struct SharedRecord {\n let value: Int\n}\n');
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(directory, 'cache'), contextBudgetUnits: 1000000,
    credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {} });
  const signal = new AbortController().signal;
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, signal);
    const operation = await workspace.openOperation(signal);
    try {
      const seeds = ['A.swift', 'B.swift'].map(path => ({ root: 'r', path, kind: 'file' as const }));
      const first = await operation.getCodeStructure({ seeds, expand: 'uses', depth: 1, signatures: false, size: 'medium', maxOutputBytes: 50000, selection: null });
      const structured = structureReply.Parse(first);
      const graph = structured.roots[0]; assert(graph);
      for (const path of ['A.swift', 'B.swift']) {
        const shared: (typeof graph.edges)[number] | undefined = graph.edges.find(edge => edge.from === 'r/' + path);
        assert(shared, `${path} lost its reference to SharedRecord`);
        assert.deepEqual(shared, { from: 'r/' + path, to: 'r/Shared.swift', symbols: ['SharedRecord'] });
        assert(graph.unresolved.some(item => item.from === 'r/' + path && item.name === 'MissingRecord'));
      }
      const reversed = await operation.getCodeStructure({ seeds: [...seeds].reverse(), expand: 'uses', depth: 1,
        signatures: false, size: 'medium', maxOutputBytes: 50000, selection: null });
      assert.deepEqual(reversed, first);
      await writeFile(join(directory, 'relationship-proof.json'), JSON.stringify({ first, reversed }, null, 2) + '\n');
    } finally { await operation.close(); }
    await workspace.close();
  } finally { await runtime.close(); }
});
