import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';

const signal = () => new AbortController().signal;
async function fixture() {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(resolve('test-output/workspace-'));
  await mkdir(join(base, 'root')); await mkdir(join(base, 'root/out'));
  const options = { cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' }, terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [] };
  const spec = { roots: [{ name: 'root', absolutePath: join(base, 'root') }], exclusions: [], outputRoot: join(base, 'root/out') };
  return { base, options, spec };
}

test('workspace policy, reconciliation, operations and persistent content reuse', async () => {
  const f = await fixture();
  const root = f.spec.roots[0]!.absolutePath;
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, '.gitignore'), '*.tmp\nignored/\n');
  await writeFile(join(root, 'nested/.gitignore'), '*.secret\n!visible.secret\n');
  await writeFile(join(root, 'file.swift'), 'struct First {}');
  await writeFile(join(root, 'note.txt'), 'first\r\nsecond\rthird');
  await writeFile(join(root, '.env'), 'excluded');
  await writeFile(join(root, 'nested/no.secret'), 'excluded');
  await writeFile(join(root, 'nested/visible.secret'), 'visible');
  await writeFile(join(root, 'junk.tmp'), 'excluded');
  await symlink('/etc', join(root, 'link'));
  const runtime = new SmipRuntime(f.options);
  try {
    const handle = await runtime.declare(f.spec, signal());
    const second = await runtime.declare(f.spec, signal());
    const a = await handle.refresh(signal());
    assert.equal(a.enumeration.kind, 'complete');
    assert.equal(a.processing, 'settled');
    const paths = a.entries.filter(entry => entry.kind === 'file').map(entry => entry.path);
    assert(paths.includes('file.swift') && paths.includes('nested/visible.secret'));
    for (const denied of ['.env', 'junk.tmp', 'nested/no.secret']) assert(!paths.includes(denied));
    const operation = await handle.openOperation(signal());
    await handle.close();
    const read = await operation.readFile({ root: 'root', path: 'note.txt', shape: { kind: 'range', start: 2, end: 3 }, maxOutputBytes: 4000, continuation: null });
    assert.equal(read.kind, 'read');
    if (read.kind !== 'read') assert.fail('Missing read');
    assert.equal(read.lines.map(line => line.text).join(''), 'second\rthird');
    await writeFile(join(root, 'file.swift'), 'struct Other {}');
    await writeFile(join(root, 'added.txt'), 'new');
    const b = await second.refresh(signal());
    assert.notEqual(a.inventoryDigest, b.inventoryDigest);
    const writers = [a, b].map(() => runtime.supervisor.spawn({ executable: process.execPath,
      args: [resolve('test/fixtures/cache-writer.mjs')], env: {}, cwd: resolve('.') }));
    await Promise.all(writers.map(writer => new Promise<void>(resolve => writer.child.stdout.once('data', () => resolve()))));
    writers.forEach((writer, index) => writer.child.stdin.end(JSON.stringify({ kind: 'membership', cache: f.options.cachePath, snapshot: [a, b][index] })));
    const observed = await runtime.artifacts.readMembership(a.workspaceKey);
    assert(observed && [a.inventoryDigest, b.inventoryDigest].includes(observed.inventoryDigest));
    assert((await Promise.all(writers.map(writer => writer.closed))).every(receipt => receipt.code === 0));
    const published = await runtime.artifacts.readMembership(a.workspaceKey);
    assert(published && [a.inventoryDigest, b.inventoryDigest].includes(published.inventoryDigest));
    await assert.rejects(operation.readSource({ root: 'root', path: 'file.swift' }), /sourceChanged/);
    await writeFile(join(root, '.gitignore'), '*.txt\n');
    await assert.rejects(operation.readSource({ root: 'root', path: 'note.txt' }), /policyChanged/);
    await operation.close(); await second.close();
    await assert.rejects(handle.refresh(signal()), /workspaceClosed/);
  } finally { await runtime.close(); }
  const restarted = new SmipRuntime(f.options);
  try {
    const handle = await restarted.declare(f.spec, signal());
    const snapshot = await handle.refresh(signal());
    assert(!snapshot.entries.some(entry => entry.kind === 'file' && entry.path === 'note.txt'));
    const membership = JSON.parse(await readFile(join(f.options.cachePath, 'v1/workspaces', snapshot.workspaceKey, 'membership.json'), 'utf8'));
    assert.equal(membership.inventoryDigest, snapshot.inventoryDigest);
    await handle.close();
  } finally { await restarted.close(); }
});

test('nested roots cannot bypass containing-root mandatory and caller exclusions', async () => {
  const f = await fixture(), root = f.spec.roots[0]!.absolutePath;
  await mkdir(join(root, 'nested')); await writeFile(join(root, 'nested/private.txt'), 'denied');
  await writeFile(join(root, 'nested/public.txt'), 'visible');
  const runtime = new SmipRuntime(f.options);
  try {
    const handle = await runtime.declare({ ...f.spec,
      roots: [...f.spec.roots, { name: 'inner', absolutePath: join(root, 'nested') }],
      exclusions: [{ kind: 'prefix', root: 'root', path: 'nested/private.txt' }] }, signal());
    const snapshot = await handle.refresh(signal());
    assert(!snapshot.entries.some(entry => entry.kind === 'file' && entry.path.endsWith('private.txt')));
    assert(snapshot.entries.some(entry => entry.kind === 'skipped' && entry.path.endsWith('private.txt')));
    assert(snapshot.entries.some(entry => entry.root === 'inner' && entry.path === 'public.txt'));
    await handle.close();
  } finally { await runtime.close(); }
});
