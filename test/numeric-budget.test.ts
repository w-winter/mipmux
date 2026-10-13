import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime } from '../src/index.js';
import { contextRequestValidator } from '../src/contracts/context.js';
import type { DiscoveryRunner } from '../src/discovery/runner.js';
import { WorkspaceFailure } from '../src/workspace/values.js';

const scoutBudget = Compile(Type.Object({ tokenBudget: Type.Integer(), initialContext: Type.String() }));

test('numeric assembly budget remains the packet limit while scout input receives the source reserve exactly once', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-numeric-budget-'));
  const root = join(base, 'root'), output = join(base, 'out');
  await mkdir(root); await mkdir(output);
  const received: { tokenBudget: number; initialContext: string }[] = [];
  const runner: DiscoveryRunner = { run: async input => {
    received.push(scoutBudget.Parse(input));
    throw new WorkspaceFailure('fixtureBudgetObserved');
  } };
  const contextBudgetUnits = 200000;
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'), contextBudgetUnits, credentialPaths: [],
    terminationGraceMs: 100, nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {} });
  const signal = new AbortController().signal;
  try {
    const client = runtime.createClient(runner);
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, signal);
    for (const budgetUnits of [200000, 1000]) {
      const request = contextRequestValidator.Parse({ task: 'Inspect the empty fixture.', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '',
        enhancementMode: 'preserve', purpose: 'investigation', requiredSources: [], documents: [], patches: [],
        discoveryHints: [], outputName: `budget-${budgetUnits}`, budgetUnits });
      const job = client.build(workspace.id, `budget-${budgetUnits}`, request);
      const terminal = await client.wait(job.jobId, 10000, signal, () => {});
      assert.equal(terminal.state, 'failed');
      if (terminal.state !== 'failed') assert.fail('Missing fixture completion');
      assert.equal(terminal.code, 'fixtureBudgetObserved');
      const observed = received[received.length - 1]; assert(observed);
      assert.equal(observed.tokenBudget, Math.max(0, budgetUnits - 1500));
      const draft = await client.createDraft(workspace.id, { ...request, outputName: `manual-${budgetUnits}` }, signal);
      const inspection = (await client.inspect(draft.id, { view: 'metadata', continuation: null, maxOutputBytes: 20000 }, new AbortController().signal));
      assert(inspection.kind === 'metadata'); assert.equal(inspection.measurement.allowance, budgetUnits);
    }
    await writeFile(join(base, 'numeric-budget-proof.json'), JSON.stringify({ contextBudgetUnits, received }, null, 2) + '\n');
  } finally { await runtime.close(); }
});
