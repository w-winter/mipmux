import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Compile } from 'typebox/compile';
import { MipmuxRuntime, verifyBundle, type ContextBuildRequest } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { gitValidator } from '../src/contracts/git.js';
import { GitArtifactReply } from '../src/contracts/git-artifact.js';
import { selectionValidator, type SelectionRequest } from '../src/contracts/selection.js';
import { scopedCall } from '../src/discovery/scoped-tools.js';
import { piToolResult } from '../src/runtime/tool-result.js';

const signal = () => new AbortController().signal;
const git = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const reply = Compile(GitArtifactReply);

async function fixture(point: 'capture' | 'merge') {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-git-selection-race-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: base,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  await writeFile(join(root, 'both.swift'), 'struct Both { let value: Int }\n');
  await writeFile(join(root, 'anchor.txt'), 'anchor\n'); await writeFile(join(root, 'later.txt'), 'later\n');
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  run(['add', '.']); run(['commit', '-qm', 'base']); await writeFile(join(root, 'anchor.txt'), 'changed anchor\n');
  let enter!: () => void, release!: () => void, armed = false;
  const entered = new Promise<void>(resolve => { enter = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  class Runtime extends MipmuxRuntime {
    override makeBridge() {
      const options = this.options;
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (armed && (point === 'capture' && operation.kind === 'prepareGitPublicationMetadata' || point === 'merge' &&
            operation.kind === 'transitionSelection' && operation.mutation.kind === 'gitPublication')) {
            armed = false; enter(); await resume;
          }
          return super.request(operation, requestSignal);
        }
      }
      return new Bridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ copyContext: copyContext(), cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000, git: { executable: git } });
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal());
  const request: ContextBuildRequest = { task: 'Original', constraints: '', enhancementMode: 'fullRewrite', purpose: 'review',
    initialSelection: { codemapMode: 'automatic', sources: [
      { kind: 'full', source: { root: 'r', path: 'both.swift' } }, { kind: 'full', source: { root: 'r', path: 'anchor.txt' } }] },
    requiredSources: [], documents: [], patches: [], copyPreset: 'standard',
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: 'packet' };
  const draft = await workspace.createDraft(request, signal()), operation = await workspace.openOperation(signal());
  const select = (input: Partial<SelectionRequest>) => draft.manageSelection(
    selectionValidator.Parse(selectionValidator.Default({ maxOutputBytes: 100000, ...input })), signal());
  const publish = (scope: 'all' | 'selected') => scopedCall({ name: 'git', input: gitValidator.Parse(gitValidator.Default({
    op: 'diff', artifacts: true, scope, snapshot_id: 'race', maxOutputBytes: 100000 })) }, draft, operation, signal(), piToolResult);
  return { runtime, draft, operation, out, entered, release, arm: () => { armed = true; }, select, publish };
}

test('Git publication retains captured full and latest manual membership through later edits and full removal', async () => {
  const proof: unknown[] = [];
  for (const scope of ['all', 'selected'] as const) {
    const f = await fixture('capture');
    try {
      f.arm();
      const pending = f.publish(scope);
      await Promise.race([f.entered, pending.then(() => assert.fail('Publication settled before the acquisition boundary'))]);
      await f.select({ op: 'demote', paths: ['r/both.swift'] });
      await f.draft.prompt({ op: 'set', text: 'Latest prompt', expectedRevision: f.draft.revision, maxOutputBytes: 100000 }, signal());
      await f.draft.update({ expectedRevision: f.draft.revision, maxOutputBytes: 100000, mutation: { kind: 'addDocument',
        document: { kind: 'suppliedDocument', id: 'later', role: 'evidence', origin: 'fixture', text: 'Latest document' } } }, signal());
      f.release(); const published = reply.Parse(await pending);
      assert.equal(published.primary_artifacts.auto_selected?.length, 2);
      const merged = await f.select({ op: 'get' });
      assert(merged.files.some(file => file.path === 'both.swift' && file.render_mode === 'full'));
      assert.equal(merged.codemap_auto_enabled, false);
      await f.draft.update({ expectedRevision: f.draft.revision, maxOutputBytes: 100000,
        mutation: { kind: 'upsert', selection: { kind: 'full', source: { root: 'r', path: 'later.txt' } } } }, signal());
      const removed = await f.select({ op: 'remove', paths: ['r/both.swift'], mode: 'full' });
      assert(removed.files.some(file => file.path === 'both.swift' && file.render_mode === 'codemap'));
      assert(removed.files.some(file => file.path === 'later.txt' && file.render_mode === 'full'));
      const finalized = await f.draft.finalize(signal()); assert.equal(finalized.kind, 'ready');
      const packet = await verifyBundle(join(f.out, 'packet'));
      assert.equal(packet.manifest.prompt, 'Latest prompt');
      const text = await readFile(join(f.out, 'packet/context.md'), 'utf8');
      assert(text.includes('Latest document')); assert(text.includes('Both'));
      proof.push({ scope, published, merged, removed, materials: packet.manifest.materials });
    } finally { f.release(); await f.operation.close(); await f.runtime.close(); }
  }
  await writeFile('test-output/git-publication-concurrent-membership-proof.json', JSON.stringify(proof, null, 2) + '\n');
});

test('a selection edit committed during native Git merge remains in the completed publication', async () => {
  const f = await fixture('merge');
  try {
    f.arm();
    const pending = f.publish('all');
    await Promise.race([f.entered, pending.then(() => assert.fail('Publication settled before the native merge boundary'))]);
    await f.select({ op: 'add', paths: ['r/later.txt'] });
    f.release(); const published = reply.Parse(await pending);
    const selected = await f.select({ op: 'get' });
    assert(selected.files.some(file => file.path === 'later.txt' && file.render_mode === 'full'));
    assert.equal(selected.revision, 2);
    assert.equal(published.primary_artifacts.auto_selected?.length, 2);
    await writeFile('test-output/git-publication-late-selection-proof.json', JSON.stringify({ published, selected }, null, 2) + '\n');
  } finally { f.release(); await f.operation.close(); await f.runtime.close(); }
});

test('publication commits dormant membership even when no new primary alias or material is added', async () => {
  const f = await fixture('capture');
  try {
    await f.publish('all');
    await f.select({ op: 'demote', paths: ['r/both.swift'] });
    f.arm(); const pending = f.publish('all');
    await Promise.race([f.entered, pending.then(() => assert.fail('Publication settled before the acquisition boundary'))]);
    await f.select({ op: 'promote', paths: ['r/both.swift'] });
    const before = f.draft.revision;
    f.release(); const published = reply.Parse(await pending);
    assert(!published.primary_artifacts.auto_selected?.length);
    assert.equal(f.draft.revision, before + 1);
    const removed = await f.select({ op: 'remove', paths: ['r/both.swift'] });
    assert(removed.files.some(file => file.path === 'both.swift' && file.render_mode === 'codemap'));
    await writeFile('test-output/git-publication-dormant-membership-proof.json', JSON.stringify({ before,
      afterPublication: before + 1, published, removed }, null, 2) + '\n');
  } finally { f.release(); await f.operation.close(); await f.runtime.close(); }
});
