import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MipmuxRuntime, verifyBundle, verifyCurrentBundle, type ContextBuildRequest } from '../src/index.js';
import { WorkspaceOperation } from '../src/workspace/workspace-operation.js';

const signal = () => new AbortController().signal;
const handoff = { clarifiedTask: 'Review', architecture: 'Files', relationships: [], ambiguities: [] };
const request: ContextBuildRequest = { task: 'Review', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', enhancementMode: 'augment' as const, purpose: 'review', requiredSources: [], documents: [], patches: [],
  discoveryHints: [], outputName: 'packet', budgetUnits: 100000 };
async function fixture() {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'mipmux-context-pass2-')), root = join(directory, 'root'), out = join(directory, 'out');
  await mkdir(root); await mkdir(out);
  const git = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(directory, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' }, contextBudgetUnits: 1000000, credentialPaths: [], terminationGraceMs: 100, git: { executable: git } });
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return { directory, root, out, runtime, run, spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out } };
}
test('participating worktree material must match retained source bytes and mode despite independently matching reads', async t => {
  for (const scenario of ['bytes', 'mode', 'absent', 'coherent'] as const) await t.test(scenario, async t => {
    const f = await fixture();
    try {
      await mkdir(join(f.root, 'scope')); await writeFile(join(f.root, 'scope/source.txt'), 'BASE\n');
      await writeFile(join(f.root, 'support.txt'), 'SUPPORT\n');
      f.run(['init']); f.run(['config', 'user.name', 'Fixture']); f.run(['config', 'user.email', 'fixture@example.invalid']);
      f.run(['add', '--all']); f.run(['commit', '-m', 'baseline']); const base = f.run(['rev-parse', 'HEAD']).trim();
      await writeFile(join(f.root, 'scope/source.txt'), 'A\n');
      const originalSource = WorkspaceOperation.prototype.readSource, originalComparison = WorkspaceOperation.prototype.readComparisonSource;
      const reads: string[] = [];
      t.mock.method(WorkspaceOperation.prototype, 'readSource', async function(this: WorkspaceOperation, source: { root: string; path: string }) {
        if (source.path === 'scope/source.txt') { await writeFile(join(f.root, source.path), 'A\n'); await chmod(join(f.root, source.path), 0o644); reads.push('source:A:644'); }
        return originalSource.call(this, source);
      });
      t.mock.method(WorkspaceOperation.prototype, 'readComparisonSource', async function(this: WorkspaceOperation, source: { root: string; path: string }) {
        if (source.path === 'scope/source.txt') {
          if (scenario === 'absent') {
            const { NativeFailure } = await import('../src/native/bridge-client.js');
            reads.push('comparison:absent'); throw new NativeFailure('notFound', 2);
          }
          await writeFile(join(f.root, source.path), scenario === 'bytes' ? 'B\n' : 'A\n');
          await chmod(join(f.root, source.path), scenario === 'mode' ? 0o755 : 0o644); reads.push('comparison:' + scenario);
        }
        return originalComparison.call(this, source);
      });
      const workspace = await f.runtime.declare(f.spec, signal());
      const draft = await workspace.createDraft({ ...request, requiredSources: [
        { kind: 'full', source: { root: 'r', path: 'scope/source.txt' } }, { kind: 'full', source: { root: 'r', path: 'support.txt' } }],
        patches: [{ kind: 'localPatch', id: 'patch', root: 'r', scope: { kind: 'paths', paths: ['scope'] },
          comparison: { kind: 'worktree', base: { kind: 'commit', ref: base }, includeUntracked: true } }] }, signal());
      await draft.prompt({ expectedRevision: 0, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify(handoff)  }, signal());
      const validation = await draft.validate(signal());
      const finalized = await draft.finalize(signal());
      if (scenario === 'coherent') { assert.equal(finalized.kind, 'ready'); if (finalized.kind === 'ready') await verifyBundle(finalized.directory); }
      else {
        assert(validation.diagnostics.some(item => item.code === 'sourceComparisonMismatch'));
        assert.equal(finalized.kind, 'blocked');
        await assert.rejects(readFile(join(f.out, 'packet/manifest.json')), { code: 'ENOENT' });
      }
      assert(reads.filter(read => read.startsWith('source:')).length >= 3);
      assert(reads.filter(read => read.startsWith('comparison:')).length >= 3);
      await writeFile(join(f.directory, 'proof.json'), JSON.stringify({ scenario, reads, validation, finalized }) + '\n');
      await draft.close(); await workspace.close();
    } finally { await f.runtime.close(); }
  });
});
test('saved supplied policy paths must equal the duplicate-free declared union and complete records detect changed policy', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'covered.txt'), 'C\n'); await writeFile(join(f.root, 'target.txt'), 'T\n');
    const workspace = await f.runtime.declare(f.spec, signal());
    const draft = await workspace.createDraft({ ...request, patches: [{ kind: 'suppliedPatch', id: 'p', root: 'r', text: 'complete patch\n', origin: 'fixture',
      comparison: { kind: 'supplied', base: 'a', target: 'b' }, coverage: ['covered.txt'],
      targets: [{ path: 'target.txt', identity: { sha256: '0'.repeat(64), byteCount: 0 }, mode: '100644' }] }] }, signal());
    await draft.prompt({ expectedRevision: 0, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify(handoff)  }, signal());
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
    const context = await readFile(join(ready.directory, 'context.md')), handoffBytes = await readFile(join(ready.directory, 'handoff.md'));
    const rejected: string[] = [];
    for (const scenario of ['removed', 'duplicate', 'unrelated'] as const) {
      const manifest = structuredClone(ready.manifest), patch = manifest.materials[0]; assert(patch?.kind === 'patch');
      if (scenario === 'removed') patch.receipt.policies.pop();
      if (scenario === 'duplicate') patch.receipt.policies.push(patch.receipt.policies[0]!);
      if (scenario === 'unrelated') patch.receipt.policies[0]!.path = 'other.txt';
      await writeFile(join(ready.directory, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(join(f.root, '.gitignore'), 'covered.txt\ntarget.txt\n');
      await assert.rejects(verifyBundle(ready.directory), /bundleIntegrityFailed/);
      await assert.rejects(verifyCurrentBundle(ready.directory, f.runtime, signal()), /bundleIntegrityFailed/);
      assert.deepEqual(await readFile(join(ready.directory, 'context.md')), context);
      assert.deepEqual(await readFile(join(ready.directory, 'handoff.md')), handoffBytes); rejected.push(scenario);
    }
    await writeFile(join(ready.directory, 'manifest.json'), JSON.stringify(ready.manifest));
    await verifyBundle(ready.directory);
    await assert.rejects(verifyCurrentBundle(ready.directory, f.runtime, signal()), /policyChanged/);
    await writeFile(join(f.directory, 'proof.json'), JSON.stringify({ rejected, completeReceiptDetectsPolicyChange: true, files: ready.manifest.files }) + '\n');
    await draft.close(); await workspace.close();
  } finally { await f.runtime.close(); }
});
