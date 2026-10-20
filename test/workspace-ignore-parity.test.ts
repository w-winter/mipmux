import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';

const signal = () => new AbortController().signal;
async function fixture() {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'smip-ignore-parity-'));
  const repo = join(directory, 'repo'), root = join(repo, 'src'), out = join(directory, 'out');
  await mkdir(root, { recursive: true }); await mkdir(out);
  const options = { copyContext: copyContext(), cachePath: join(directory, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 200000,
    credentialPaths: [], nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {} };
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out };
  const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
  const run = (args: string[]) => execFileSync(git, args, { cwd: repo, encoding: 'utf8', env: {
    PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  } });
  return { directory, repo, root, out, options, spec, run };
}

test('loaded subroots inherit Git controls and retain the mandatory floor across repo/cursor negation', async () => {
  const f = await fixture(); f.run(['init', '-q']);
  await writeFile(join(f.repo, '.gitignore'), 'src/git-denied.swift\n');
  await writeFile(join(f.repo, '.repo_ignore'), '**/*.swift\n');
  await writeFile(join(f.repo, '.cursorignore'), '!src/Main.swift\n!src/git-denied.swift\n');
  await mkdir(join(f.root, 'nested'));
  await writeFile(join(f.root, 'nested/.repo_ignore'), '!Kept.swift\n');
  for (const path of ['Main.swift', 'git-denied.swift', 'Other.swift', 'nested/Kept.swift']) {
    await writeFile(join(f.root, path), 'struct Record {}\n');
  }
  const runtime = new SmipRuntime(f.options);
  try {
    const workspace = await runtime.declare(f.spec, signal());
    const snapshot = await workspace.refresh(signal());
    assert.equal(snapshot.enumeration.kind, 'complete');
    assert.deepEqual(snapshot.entries.filter(entry => entry.kind === 'file' && entry.path.endsWith('.swift')).map(entry => entry.path),
      ['Main.swift', 'nested/Kept.swift']);
    const operation = await workspace.openOperation(signal());
    try {
      await assert.rejects(operation.readSource({ root: 'r', path: 'git-denied.swift' }), /unavailableSource/);
      await assert.rejects(operation.readComparisonSource({ root: 'r', path: 'git-denied.swift' }), /pathDenied/);
      assert.equal((await operation.readSource({ root: 'r', path: 'Main.swift' })).text, 'struct Record {}\n');
    } finally { await operation.close(); }
    const draft = await workspace.createDraft({ task: 'Inspect inherited visibility', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', enhancementMode: 'preserve',
      purpose: 'investigation', requiredSources: [{ kind: 'full', source: { root: 'r', path: 'Main.swift' } }],
      documents: [], patches: [], budgetUnits: 200000, discoveryHints: [], outputName: 'packet' }, signal());
    try {
      const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
      await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, runtime, signal());
      await writeFile(join(f.repo, '.cursorignore'), '!src/Main.swift\n# changed ancestor input\n');
      await assert.rejects(verifyCurrentBundle(ready.directory, runtime, signal()), /policyChanged/);
      await writeFile(join(f.directory, 'inherited-policy-receipt.json'), JSON.stringify({
        selected: snapshot.entries.filter(entry => entry.kind === 'file').map(entry => entry.path),
        packet: ready.directory, currentPolicyChangeRejected: true,
      }, null, 2) + '\n');
    } finally { await draft.close(); await workspace.close(); }
  } finally { await runtime.close(); }
});

test('source global defaults and ordinary-crawl negation reachability govern the admitted view', async () => {
  const f = await fixture();
  await mkdir(join(f.root, 'node_modules')); await mkdir(join(f.root, 'ignored'));
  await writeFile(join(f.root, 'node_modules/vendor.swift'), 'struct Vendor {}\n');
  await writeFile(join(f.root, '.repo_ignore'), 'ignored/\n!ignored/keep.swift\n');
  await writeFile(join(f.root, 'ignored/keep.swift'), 'struct Kept {}\n');
  await writeFile(join(f.root, 'ignored/drop.swift'), 'struct Dropped {}\n');
  const runtime = new SmipRuntime(f.options);
  try {
    const workspace = await runtime.declare(f.spec, signal());
    const snapshot = await workspace.refresh(signal());
    assert.equal(snapshot.enumeration.kind, 'complete');
    assert.deepEqual(snapshot.entries.filter(entry => entry.kind === 'file' && entry.path.endsWith('.swift')).map(entry => entry.path),
      ['ignored/keep.swift']);
    const operation = await workspace.openOperation(signal());
    try {
      assert.equal((await operation.readSource({ root: 'r', path: 'ignored/keep.swift' })).text, 'struct Kept {}\n');
      await assert.rejects(operation.readSource({ root: 'r', path: 'node_modules/vendor.swift' }), /unavailableSource/);
    } finally { await operation.close(); await workspace.close(); }
    await writeFile(join(f.directory, 'negation-receipt.json'), JSON.stringify(snapshot.entries, null, 2) + '\n');
  } finally { await runtime.close(); }
});

test('an ignored ancestor prevents deeper control acquisition when no crawl is admitted', async () => {
  const f = await fixture(); f.run(['init', '-q']);
  await mkdir(join(f.root, 'excluded'));
  await writeFile(join(f.repo, '.gitignore'), 'src/excluded/\n');
  await writeFile(join(f.root, 'excluded/.gitignore'), Buffer.from([0xff, 0xfe, 0x00, 0xd8]));
  await writeFile(join(f.root, 'excluded/hidden.swift'), 'struct Hidden {}\n');
  const runtime = new SmipRuntime(f.options);
  try {
    const workspace = await runtime.declare(f.spec, signal());
    const operation = await workspace.openOperation(signal());
    try {
      assert.equal(operation.snapshot.enumeration.kind, 'complete');
      await assert.rejects(operation.readComparisonSource({ root: 'r', path: 'excluded/hidden.swift' }), /pathDenied/);
      await writeFile(join(f.directory, 'locked-rules-receipt.json'), JSON.stringify({
        enumeration: operation.snapshot.enumeration, ignoredComparisonRejected: true,
      }, null, 2) + '\n');
    } finally { await operation.close(); await workspace.close(); }
  } finally { await runtime.close(); }
});

test('configured ignore layers and hierarchy switches control public source access', async () => {
  const f = await fixture();
  await mkdir(join(f.root, 'nested'));
  await writeFile(join(f.root, '.repo_ignore'), 'repo.swift\n');
  await writeFile(join(f.root, '.cursorignore'), 'cursor.swift\n');
  await writeFile(join(f.root, 'nested/.gitignore'), 'child.swift\n');
  for (const path of ['repo.swift', 'cursor.swift', 'global.swift', 'nested/child.swift']) {
    await writeFile(join(f.root, path), 'struct Record {}\n');
  }
  const cases = [
    { respectRepoIgnore: true, respectCursorignore: true, enableHierarchicalIgnores: true, paths: [] },
    { respectRepoIgnore: false, respectCursorignore: true, enableHierarchicalIgnores: true, paths: ['repo.swift'] },
    { respectRepoIgnore: true, respectCursorignore: false, enableHierarchicalIgnores: true, paths: ['cursor.swift'] },
    { respectRepoIgnore: false, respectCursorignore: false, enableHierarchicalIgnores: false,
      paths: ['cursor.swift', 'nested/child.swift', 'repo.swift'] },
  ];
  const receipts = [];
  for (const { paths, ...switches } of cases) {
    const runtime = new SmipRuntime({ ...f.options, ignoreSettings: { global: 'global.swift\n', ...switches } });
    try {
      const workspace = await runtime.declare(f.spec, signal());
      const operation = await workspace.openOperation(signal());
      try {
        assert.equal(operation.snapshot.enumeration.kind, 'complete');
        const actual = operation.snapshot.entries.filter(entry => entry.kind === 'file' && entry.path.endsWith('.swift'))
          .map(entry => entry.path);
        assert.deepEqual(actual, paths);
        for (const path of paths) assert.equal((await operation.readSource({ root: 'r', path })).text, 'struct Record {}\n');
        await assert.rejects(operation.readComparisonSource({ root: 'r', path: 'global.swift' }), /pathDenied/);
        receipts.push({ switches, paths: actual, policy: operation.snapshot.policy.digest });
      } finally { await operation.close(); await workspace.close(); }
    } finally { await runtime.close(); }
  }
  await writeFile(join(f.directory, 'settings-receipt.json'), JSON.stringify(receipts, null, 2) + '\n');
});

test('separate Git administration directories retain containing-repository ignore authority', async () => {
  const f = await fixture();
  f.run(['init', '-q', '--separate-git-dir', join(f.directory, 'administration')]);
  await writeFile(join(f.repo, '.gitignore'), 'src/hidden.swift\n');
  await writeFile(join(f.root, '.repo_ignore'), '!hidden.swift\n');
  for (const path of ['Main.swift', 'hidden.swift']) await writeFile(join(f.root, path), 'struct Record {}\n');
  const runtime = new SmipRuntime(f.options);
  try {
    const workspace = await runtime.declare(f.spec, signal());
    const operation = await workspace.openOperation(signal());
    try {
      assert.equal(operation.snapshot.enumeration.kind, 'complete');
      assert.deepEqual(operation.snapshot.entries.filter(entry => entry.kind === 'file' && entry.path.endsWith('.swift'))
        .map(entry => entry.path), ['Main.swift']);
      await assert.rejects(operation.readComparisonSource({ root: 'r', path: 'hidden.swift' }), /pathDenied/);
      await writeFile(join(f.directory, 'separate-git-receipt.json'), JSON.stringify(operation.snapshot.policy, null, 2) + '\n');
    } finally { await operation.close(); await workspace.close(); }
  } finally { await runtime.close(); }
});
