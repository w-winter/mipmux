import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';

const signal = () => new AbortController().signal;
const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const omittedFiles = Compile(Type.Object({ unavailableRoots: Type.Array(Type.Unknown()), unavailableFiles: Type.Array(Type.Object({
  id: Type.String(), selection: Type.Object({ kind: Type.String(), source: Type.Object({ path: Type.String() }) }),
  code: Type.String(), selectionIndex: Type.Integer() })) }));

async function fixture(mode: 'manual' | 'automatic', effect: 'missing' | 'required' | 'changed' | 'restoreBeforeClaim') {
  const base = await mkdtemp(join(tmpdir(), 'smip-optional-file-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out);
  await writeFile(join(root, 'Absent.swift'), 'struct AbsentSeed { let peer: AbsentPeer }\n');
  await writeFile(join(root, 'AbsentPeer.swift'), 'struct AbsentPeer { let value: Int }\n');
  await writeFile(join(root, 'Healthy.swift'), 'struct HealthySeed { let peer: HealthyPeer }\n');
  await writeFile(join(root, 'HealthyPeer.swift'), 'struct HealthyPeer { let value: Int }\n');
  await writeFile(join(root, 'slice.txt'), 'first\nabsent slice body\nlast\n');
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  run(['add', '.']); run(['commit', '-qm', 'base']);
  const restore = async () => { for (const path of ['Absent.swift', 'slice.txt']) await rename(join(base, path), join(root, path)); };
  let armed = effect === 'restoreBeforeClaim';
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (armed && operation.kind === 'readExport') { armed = false; await restore(); }
          return super.request(operation, requestSignal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, git: { executable: git } });
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal());
  const full = { kind: 'full' as const, source: { root: 'r', path: 'Absent.swift' } };
  const draft = await workspace.createDraft({ task: 'Export readable selection', constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: mode, sources: [full,
      { kind: 'slices', source: { root: 'r', path: 'slice.txt' }, ranges: [{ start: 2, end: 2, description: null }] },
      { kind: 'full', source: { root: 'r', path: 'Healthy.swift' } }] }, requiredSources: effect === 'required' ? [full] : [],
    documents: [], patches: [], discoveryHints: [], budgetUnits: 100000, outputName: 'packet',
    copyPreset: 'codeReview', duplicateUserInstructionsAtTop: false }, signal());
  if (effect === 'changed') await writeFile(join(root, 'Absent.swift'), 'struct ChangedAvailableBody {}\n');
  else for (const path of ['Absent.swift', 'slice.txt']) await rename(join(root, path), join(base, path));
  return { runtime, workspace, draft, root, out, restore };
}

for (const [mode, refresh] of [['manual', false], ['automatic', false], ['automatic', true]] as const) {
  test(`${mode} optional file export retains healthy bodies with catalog refresh ${refresh}`, async () => {
    const f = await fixture(mode, 'missing');
    try {
      if (refresh) await f.workspace.refresh(signal());
      const original = f.draft.selectionProjection(), result = await f.draft.finalize(signal());
      assert(result.kind === 'ready', JSON.stringify(result));
      const omissions = omittedFiles.Parse(result.manifest);
      assert.equal(omissions.unavailableRoots.length, 0);
      assert.deepEqual(omissions.unavailableFiles.map(source => [source.selection.source.path, source.selection.kind, source.code, source.selectionIndex]),
        [['Absent.swift', 'full', 'notFound', 0], ['slice.txt', 'slices', 'notFound', 1]]);
      const context = await readFile(join(result.directory, 'context.md'), 'utf8');
      assert(context.includes('struct HealthySeed'));
      assert.deepEqual(result.manifest.materials.flatMap(record => record.kind === 'source' && record.selectionOrigin === 'explicit'
        ? [record.selection.source.path] : []), ['Healthy.swift']);
      if (mode === 'automatic') assert(context.includes('File: r/HealthyPeer.swift\nImports:'));
      if (!refresh) assert(context.includes('-struct AbsentSeed'), 'Review keeps authorized deletion evidence for the omitted body');
      await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, f.runtime, signal());
      assert.deepEqual(f.draft.selectionProjection(), original);
      const costs = await f.draft.inspect({ view: 'costs', continuation: null, maxOutputBytes: 100000 }, signal());
      assert(costs.kind === 'costs'); assert.equal(costs.measurement.bytes, result.manifest.accounting.bytes);
      assert(new Set<string>(costs.token_accounting.incomplete_components).has('files'));
      await f.restore();
      await assert.rejects(verifyCurrentBundle(result.directory, f.runtime, signal()), /sourceAvailabilityChanged/);
      await verifyBundle(result.directory);
      await mkdir('test-output', { recursive: true });
      await writeFile(`test-output/optional-file-${mode}-${refresh}.json`, JSON.stringify({ result, costs, original }, null, 2) + '\n');
    } finally { await f.runtime.close(); }
  });
}

for (const effect of ['required', 'changed', 'restoreBeforeClaim'] as const) test(`${effect} does not publish an optional-file omission packet`, async () => {
  const f = await fixture('manual', effect);
  try {
    await assert.rejects(f.draft.finalize(signal()), effect === 'required' ? /notFound/ : effect === 'changed' ? /sourceChanged/ : /sourceAvailabilityChanged/);
    await assert.rejects(readFile(join(f.out, 'packet/manifest.json')), /ENOENT/);
  } finally { await f.runtime.close(); }
});
