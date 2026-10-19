import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { type ContextBuildRequest, SmipRuntime, verifyBundle } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import type { RootIdentity } from '../src/contracts/workspace.js';

const signal = () => new AbortController().signal;
const native = resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`);
const limited = resolve('test/fixtures/limited-native.sh');
const environment = (limit: number) => ({ SMIP_NATIVE: native, SMIP_FD_LIMIT: String(limit), REPOPROMPT_PCRE2_JIT: 'disabled' });

test('repeated root revalidation keeps descriptor use bounded and preserves identity, access and generation authority', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(resolve('test-output/descriptors-'));
  const source = join(base, 'source'), output = join(base, 'out');
  await mkdir(source); await mkdir(output);
  await writeFile(join(source, 'file.swift'), 'struct Example {}');
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ executable: limited, supervisor, env: environment(24) });
  try {
    const declare = (sourceExpected: RootIdentity | null, outputExpected: RootIdentity | null) => bridge.request({ kind: 'openRoots', roots: [
      { name: 'source', absolutePath: source, access: 'source', expected: sourceExpected },
      { name: 'output', absolutePath: output, access: 'output', expected: outputExpected },
    ] }, signal());
    const opened = await declare(null, null);
    const [sourceRoot, outputRoot] = opened.result.roots;
    assert(sourceRoot && outputRoot);
    const revalidations = 40;
    for (let round = 0; round < revalidations; round++) {
      const again = await declare(sourceRoot.identity, outputRoot.identity);
      assert.deepEqual(again.result.roots.map(root => root.identity), [sourceRoot.identity, outputRoot.identity]);
      assert.deepEqual(again.result.roots.map(root => root.access), ['source', 'output']);
    }
    assert.equal((await bridge.request({ kind: 'readSource', root: sourceRoot.handle, path: 'file.swift', expected: null }, signal())).bytes.toString(), 'struct Example {}');
    await assert.rejects(bridge.request({ kind: 'beginExport', root: sourceRoot.handle, name: 'run' }, signal()), /invalidOutputCapability/);
    await assert.rejects(bridge.request({ kind: 'readSource', root: outputRoot.handle, path: 'file.swift', expected: null }, signal()), /invalidSourceCapability/);
    const dual = await bridge.request({ kind: 'openRoots', roots: [{ name: 'dual', absolutePath: source, access: 'output', expected: null }] }, signal());
    const dualRoot = dual.result.roots[0]; assert(dualRoot);
    assert.notDeepEqual(dualRoot.handle, sourceRoot.handle, 'source and output authority must not merge');
    await assert.rejects(bridge.request({ kind: 'readSource', root: dualRoot.handle, path: 'file.swift', expected: null }, signal()), /invalidSourceCapability/);
    await assert.rejects(bridge.request({ kind: 'readSource', root: { generation: 'foreign', id: sourceRoot.handle.id }, path: 'file.swift', expected: null }, signal()), /invalidRootHandle/);
    await rename(source, source + '-moved'); await mkdir(source); await writeFile(join(source, 'file.swift'), 'struct Replacement {}');
    await assert.rejects(declare(sourceRoot.identity, outputRoot.identity), /rootChanged/);
    await assert.rejects(bridge.request({ kind: 'readSource', root: sourceRoot.handle, path: 'file.swift', expected: null }, signal()), /rootChanged/);
    const replaced = await declare(null, outputRoot.identity);
    const replacedRoot = replaced.result.roots[0]; assert(replacedRoot);
    assert.notEqual(replacedRoot.identity.inode, sourceRoot.identity.inode);
    assert.equal((await bridge.request({ kind: 'readSource', root: replacedRoot.handle, path: 'file.swift', expected: null }, signal())).bytes.toString(), 'struct Replacement {}');
    await writeFile(join(base, 'descriptor-proof.json'), JSON.stringify({ limit: 24, revalidations, rootsPerRevalidation: 2 }) + '\n');
  } finally { await bridge.close(); await supervisor.close(); }
});

test('two-phase finalization across many roots completes under a controlled descriptor budget', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-many-roots-'));
  const count = 24, limit = 64, outputRoot = join(base, 'out');
  await mkdir(outputRoot);
  const roots: { name: string; absolutePath: string }[] = [];
  for (let index = 0; index < count; index++) {
    const name = 'r' + String(index).padStart(2, '0'), absolutePath = join(base, name);
    await mkdir(absolutePath); await writeFile(join(absolutePath, 'file.txt'), 'body ' + name + '\n');
    roots.push({ name, absolutePath });
  }
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: limited, nativeEnvironment: environment(limit) });
  const request: ContextBuildRequest = { task: 'Task', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation', documents: [], patches: [], discoveryHints: [],
    requiredSources: roots.map(root => ({ kind: 'full', source: { root: root.name, path: 'file.txt' } })), outputName: 'packet',
    budgetUnits: 100000 };
  try {
    const workspace = await runtime.declare({ roots, exclusions: [], outputRoot }, signal());
    const operation = await workspace.openOperation(signal());
    const revalidations = 6;
    for (let round = 0; round < revalidations; round++) await operation.validateRoots();
    assert.equal((await operation.readSource({ root: 'r00', path: 'file.txt' })).bytes.toString(), 'body r00\n');
    await operation.close();
    const draft = await workspace.createDraft(request, signal());
    await draft.prompt({ expectedRevision: 0, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify({ clarifiedTask: 'Task', architecture: 'Many roots', relationships: [], ambiguities: [] })  }, signal());
    const result = await draft.finalize(signal());
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') assert.fail('unreachable');
    await verifyBundle(result.directory);
    assert.equal(result.manifest.materials.length, count);
    await writeFile(join(base, 'many-roots-proof.json'), JSON.stringify({ roots: count, limit, revalidations, directory: result.directory }) + '\n');
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});
