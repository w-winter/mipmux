import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime, verifyBundle, type CodemapMode } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { selectionValidator } from '../src/contracts/selection.js';

const referenceOutput = Compile(Type.Array(Type.Object({ name: Type.String(), trace: Type.Array(Type.String()),
  operations: Type.Array(Type.Object({ entries: Type.Array(Type.String()) })),
})));
const sourceBody = 'struct FirstRecord { let value: Int }\n';
type Scenario = 'render-transient' | 'render-persistent' | 'publication-persistent';

async function fixture(mode: CodemapMode, scenario: Scenario, maximumAttempts: number) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'smip-presentation-retry-')));
  for (const name of ['a', 'b', 'out']) await mkdir(join(base, name));
  await writeFile(join(base, 'a/f.swift'), sourceBody);
  await writeFile(join(base, 'b/h.swift'), 'struct HealthyRecord { let value: Int }\n');
  await writeFile(join(base, 'a/Seed.swift'), 'struct SeedA { let value: FirstRecord }\n');
  await writeFile(join(base, 'b/Seed.swift'), 'struct SeedB { let value: HealthyRecord }\n');
  let armed = false, invalidations = 0, publicationInvalidated = false;
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (armed && operation.kind === 'readSource' && operation.path === 'f.swift' &&
              (scenario === 'render-persistent' || scenario === 'render-transient' && invalidations === 0)) {
            invalidations++;
            if (invalidations > maximumAttempts) throw new Error('Source presentation attempt limit exceeded');
            await writeFile(join(base, 'a/f.swift'), 'struct Changed { let flag: Bool }\n');
            try { return await super.request(operation, signal); }
            finally { await writeFile(join(base, 'a/f.swift'), sourceBody); }
          }
          const reply = await super.request(operation, signal);
          if (armed && scenario === 'publication-persistent' && operation.kind === 'renderSelectionReply' && !publicationInvalidated) {
            publicationInvalidated = true;
            await writeFile(join(base, 'a/f.swift'), 'struct Changed { let flag: Bool }\n');
          }
          return reply;
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = new AbortController().signal, client = runtime.createClient(null);
  const workspace = await client.declare({ roots: [{ name: 'a', absolutePath: join(base, 'a') }, { name: 'b', absolutePath: join(base, 'b') }],
    exclusions: [], outputRoot: join(base, 'out') }, signal);
  const required = mode === 'manual' ? { kind: 'codemap' as const, source: { root: 'a', path: 'f.swift' } }
    : { kind: 'full' as const, source: { root: 'a', path: 'Seed.swift' } };
  const initialSelection = mode === 'manual'
    ? { codemapMode: mode, sources: [{ kind: 'codemap' as const, source: { root: 'b', path: 'h.swift' } }] }
    : { codemapMode: mode, sources: [{ kind: 'full' as const, source: { root: 'b', path: 'Seed.swift' } }] };
  const draft = await client.createDraft(workspace.id, { task: 'Inspect', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
    initialSelection, requiredSources: [required], documents: [], patches: [],
    duplicateUserInstructionsAtTop: false, copyPreset: 'standard', budgetUnits: 100000, discoveryHints: [], outputName: scenario }, signal);
  const get = () => client.manageSelection(draft.id, selectionValidator.Parse(selectionValidator.Default({
    op: 'get', view: 'content', maxOutputBytes: 30000,
  })), signal);
  return { base, client, runtime, draft, signal, get, arm: () => { armed = true; }, disarm: () => { armed = false; }, invalidations: () => invalidations };
}

for (const mode of ['manual', 'automatic'] as const) for (const scenario of ['render-transient', 'render-persistent', 'publication-persistent'] as const) {
  test(`${mode} codemap presentation applies source stale attempts and publication checks: ${scenario}`, async () => {
    const outputs = referenceOutput.Parse(JSON.parse(await readFile('test/fixtures/rpce-presentation-retry/expected.json', 'utf8')));
    const name = scenario === 'render-transient' ? 'first-stale-then-ready'
      : scenario === 'render-persistent' ? 'both-stale-nil-discards-healthy' : 'publication-stale-both';
    const expected = outputs.find(output => output.name === name)!;
    const maximumAttempts = expected.trace.filter(line => line.startsWith('make#')).length;
    const f = await fixture(mode, scenario, maximumAttempts);
    try {
      const baseline = await f.get();
      assert.equal(baseline.files.filter(file => file.render_mode === 'codemap').length, 2);
      f.arm();
      const reply = await f.get();
      assert.equal(reply.revision, 0);
      assert.deepEqual(reply.files.filter(file => file.render_mode === 'codemap').map(file => file.path).sort(), [...expected.operations.at(-1)!.entries].sort());
      assert.equal(reply.measurement.complete, scenario === 'render-transient');
      if (scenario === 'render-persistent') assert.equal(f.invalidations(), maximumAttempts);
      f.disarm();
      await writeFile(join(f.base, 'a/f.swift'), sourceBody);
      const recovered = await f.get();
      assert.equal(recovered.revision, 0); assert.equal(recovered.measurement.complete, true);
      assert.equal(recovered.files.filter(file => file.render_mode === 'codemap').length, 2);
      const finalized = await f.client.finalize(f.draft.id, f.signal); assert.equal(finalized.kind, 'ready');
      if (finalized.kind === 'ready') await verifyBundle(finalized.directory);
      await mkdir('test-output', { recursive: true });
      await writeFile(`test-output/presentation-retry-${mode}-${scenario}-proof.json`, JSON.stringify({ reply, recovered, finalized,
        invalidations: f.invalidations(), maximumAttempts }, null, 2) + '\n');
    } finally { await f.client.close(); await f.runtime.close(); }
  });
}
