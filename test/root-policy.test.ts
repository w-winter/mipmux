import { copyContext } from './fixtures/copy-context.js';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';

test('ordered ignore negation, excluded parents, nested aliases and new control inputs share one policy', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-policy-'));
  const root = join(base, 'root'); await mkdir(root); await mkdir(join(root, 'out'));
  await mkdir(join(root, 'nested')); await mkdir(join(root, 'denied'));
  await writeFile(join(root, '.gitignore'), '*.txt\ndenied/\n.gitignore\n');
  await writeFile(join(root, 'nested/.gitignore'), '!keep.txt\n');
  await writeFile(join(root, 'nested/keep.txt'), 'keep');
  await writeFile(join(root, 'nested/drop.txt'), 'drop');
  await writeFile(join(root, 'denied/.gitignore'), '!keep.txt');
  await writeFile(join(root, 'denied/keep.txt'), 'denied');
  await writeFile(join(root, 'data.swift'), 'struct Record {\n let value: String\n}');
  await mkdir(join(root, 'fresh')); await writeFile(join(root, 'fresh/model.swift'), 'struct Model {\n let value: String\n}');
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(root, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } });
  const spec = { roots: [{ name: 'outer', absolutePath: root }, { name: 'inner', absolutePath: join(root, 'denied') }], exclusions: [], outputRoot: join(root, 'out') };
  try {
    const handle = await runtime.declare(spec, new AbortController().signal);
    const snapshot = await handle.refresh(new AbortController().signal);
    assert.equal(snapshot.enumeration.kind, 'complete');
    const files = snapshot.entries.filter(entry => entry.kind === 'file');
    assert(files.some(entry => entry.path === 'nested/keep.txt'));
    assert(!files.some(entry => entry.root === 'inner' || entry.path === '.gitignore' || entry.path.startsWith('cache/') || entry.path.endsWith('drop.txt')));
    assert(snapshot.policy.inputs.some(input => input.name === '.gitignore' && input.content.kind === 'present'));
    const op = await handle.openOperation(new AbortController().signal);
    await op.readSource({ root: 'outer', path: 'fresh/model.swift' });
    await writeFile(join(root, 'fresh/.gitignore'), '# Newly created controlling input\n');
    await assert.rejects(op.readSource({ root: 'outer', path: 'fresh/model.swift' }), /policyChanged/);
    await writeFile(join(root, 'nested/.gitignore'), '*.txt');
    await assert.rejects(op.readSource({ root: 'outer', path: 'nested/keep.txt' }), /policyChanged/);
    await op.close(); await handle.close();
    await mkdir(join(base, 'symlink-policy')); await symlink(join(root, '.gitignore'), join(base, 'symlink-policy/.gitignore'));
    const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
    execFileSync(git, ['init', '-q'], { cwd: join(base, 'symlink-policy'), env: { PATH: '/usr/bin:/bin', HOME: base,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    const bad = await runtime.declare({ ...spec, roots: [{ name: 'bad', absolutePath: join(base, 'symlink-policy') }] }, new AbortController().signal);
    assert.equal((await bad.refresh(new AbortController().signal)).enumeration.kind, 'incomplete');
    const partial = await bad.openOperation(new AbortController().signal);
    assert.equal(partial.snapshot.enumeration.kind, 'incomplete');
    await partial.close();
    await bad.close();
  } finally { await runtime.close(); }
});

test('credential denies through a containing root alias apply to ordinary declaration and all confined readers', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-credential-alias-'));
  const root = join(base, 'root'), alias = join(base, 'alias');
  await mkdir(join(root, 'nested'), { recursive: true }); await mkdir(join(base, 'out'));
  await symlink(root, alias);
  await writeFile(join(root, 'nested/private.txt'), 'synthetic denied body');
  await writeFile(join(root, 'nested/public.txt'), 'admitted');
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100,
    contextBudgetUnits: 1000000, credentialPaths: [join(base, 'credential-link')],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } });
  const signal = new AbortController().signal;
  await symlink(join(root, 'nested/private.txt'), join(base, 'credential-link'));
  try {
    const handle = await runtime.declare({ roots: [{ name: 'outer', absolutePath: alias }, { name: 'inner', absolutePath: join(root, 'nested') }],
      exclusions: [], outputRoot: join(base, 'out') }, signal);
    const snapshot = await handle.refresh(signal);
    assert.equal(snapshot.enumeration.kind, 'complete');
    assert(!snapshot.entries.some(entry => entry.kind === 'file' && entry.path.endsWith('private.txt')));
    const operation = await handle.openOperation(signal);
    for (const source of [{ root: 'outer', path: 'nested/private.txt' }, { root: 'inner', path: 'private.txt' }]) {
      await assert.rejects(operation.readSource(source), /unavailableSource/);
      await assert.rejects(operation.readComparisonSource(source), /pathDenied/);
    }
    assert.equal((await operation.readSource({ root: 'inner', path: 'public.txt' })).bytes.toString(), 'admitted');
    await operation.close(); await handle.close();
  } finally { await runtime.close(); }
});

test('later control negation reopens a parent before admitting its children', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-parent-ignore-'));
  const root = join(base, 'root');
  const directories = ['nested', 'nested[\n]'];
  for (const directory of directories) await mkdir(join(root, directory, 'cache'), { recursive: true });
  await mkdir(join(base, 'out'));
  await writeFile(join(root, '.gitignore'), 'cache/\n');
  for (const directory of directories) {
    await writeFile(join(root, directory, '.gitignore'), '\uFEFF!cache/\r\n\t\r\n');
    await writeFile(join(root, directory, 'cache/file.txt'), 'public');
    await writeFile(join(root, directory, 'cache/\t'), 'ignored tab name');
  }
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {} });
  try {
    const handle = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: join(base, 'out') }, new AbortController().signal);
    const snapshot = await handle.refresh(new AbortController().signal);
    for (const directory of directories) assert(snapshot.entries.some(entry => entry.kind === 'file' && entry.path === directory + '/cache/file.txt'));
    assert(snapshot.entries.some(entry => entry.kind === 'file' && entry.path.endsWith('/\t')));
    const operation = await handle.openOperation(new AbortController().signal);
    for (const directory of directories) assert.equal((await operation.readSource({ root: 'r', path: directory + '/cache/file.txt' })).bytes.toString(), 'public');
    await operation.close(); await handle.close();
  } finally { await runtime.close(); }
});
