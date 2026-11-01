import { nativeDiscoveryRenderer } from './fixtures/render-discovery-prompt.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { ProcessSupervisor, type ProcessSpec } from '../src/runtime/process-supervisor.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import { selectDiscovery } from '../src/discovery/selection.js';

test('untrusted worker generations, late records and premature completion cannot grant readiness or tools', async () => {
  const provider = await scriptedProvider(() => { throw new Error('No model expected'); });
  try {
    for (const scenario of ['wrongGeneration', 'incompleteReceipt', 'duplicate', 'outstandingTool', 'deferred', 'aborted', 'length', 'empty']) {
      let calls = 0;
      class Supervisor extends ProcessSupervisor {
        override spawn(spec: ProcessSpec) {
          if (!spec.args.some(arg => arg.endsWith('/pi-worker.js'))) return super.spawn(spec);
          return super.spawn({ ...spec, args: [resolve('test/fixtures/pi-worker.mjs')], env: { SCENARIO: scenario } });
        }
      }
      const supervisor = new Supervisor({ terminationGraceMs: 0 });
      try {
        const result = await new PiRunner(provider.config, supervisor, nativeDiscoveryRenderer(supervisor)).run({ tokenBudget: 10000, enhancementMode: 'fullRewrite' as const, task: 'Task', purpose: 'investigation', initialContext: 'Fixture context', fileTree: '', currentPrompt: 'Fixture message', restrictsReviewGitToExplicitReadOnly: true, constraints: '', roots: [], hints: [] },
          { call: async (_call, signal) => {
            calls++;
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
            return { kind: 'metadata' };
          } }, new AbortController().signal, () => {}, selectDiscovery(provider.config, undefined));
        assert.equal(result.kind, 'failed', scenario);
        assert.equal(result.receipt.workerClosed, true);
        assert.equal(calls, scenario === 'outstandingTool' ? 1 : 0);
      } finally { await supervisor.close(); }
    }
  } finally { await provider.close(); }
});
