import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { runPiSession } from '../src/discovery/pi-session.js';
import { createCredentials } from '../src/discovery/pi-credentials.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import type { Evidence } from '../src/discovery/pi-protocol.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';

test('real isolated SDK has only scoped tools, observes same-model recovery and joins closure', async () => {
  const provider = await scriptedProvider((summary, index) => {
    assert.equal(summary, false);
    return index === 1 ? { kind: 'error' } : { kind: 'text', text: 'Discovery complete.', stop: 'end_turn', tokens: 10 };
  });
  provider.config.policy.compaction.enabled = false;
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  try {
    const runner = new PiRunner(provider.config, supervisor);
    const result = await runner.run({ task: 'Inspect', constraints: '', hints: [], roots: ['r'] },
      { call: async () => { throw new Error('Unexpected tool'); } }, new AbortController().signal, () => {});
    assert.equal(result.kind, 'complete');
    assert.equal(result.receipt.workerClosed, true);
    assert.equal(result.receipt.disposed, true);
    assert.equal(result.receipt.settled, true);
    assert.equal(result.receipt.idle, true);
    assert.equal(result.receipt.observationsSettled, true);
    assert.equal(result.receipt.parentToolsSettled, true);
    assert.equal(result.receipt.acceptedRuns, 1);
    assert.equal(result.receipt.prompt, 'resolved');
    assert.equal(result.receipt.buildLockSHA256, createHash('sha256').update(await readFile('package-lock.json')).digest('hex'));
    assert.equal(result.receipt.completions.at(-1)?.stopReason, 'stop');
    assert(result.receipt.events.some(event => event.kind === 'auto_retry_start'));
    assert.equal(provider.requests.length, 2);
    for (const recorded of provider.requests) {
      assert.equal(recorded.model, provider.config.model);
      assert.deepEqual(recorded.tools.sort(), ['draft_inspect', 'draft_update', 'draft_validate', 'file_search', 'get_code_structure', 'get_file_tree', 'read_file'].sort());
    }
    await writeFile(join(provider.directory, 'receipt.json'), JSON.stringify(result, null, 2));
  } finally { await supervisor.close(); await provider.close(); }
});

test('SDK consumes the validated model snapshot and guards each locked credential read', async t => {
  for (const kind of ['models', 'auth'] as const) {
    await t.test(kind, async t => {
    const provider = await scriptedProvider(() => ({ kind: 'text', text: 'Complete.', stop: 'end_turn', tokens: 10 }));
    provider.config.policy.compaction.enabled = false;
    const marker = join(provider.directory, 'command-executed');
    const target = kind === 'models' ? provider.config.modelsPath : provider.config.authPath;
    const originalRead = fsPromises.readFile;
    let substituted = false;
    const observations: Evidence[] = [];
    const models: unknown = JSON.parse(await originalRead(provider.config.modelsPath, 'utf8'));
    assert(models && typeof models === 'object' && 'providers' in models);
    const providers = models.providers;
    assert(providers && typeof providers === 'object' && 'anthropic' in providers);
    const anthropic = providers.anthropic;
    assert(anthropic && typeof anthropic === 'object' && 'baseUrl' in anthropic);
    assert.equal(typeof anthropic.baseUrl, 'string');
    const replacement = kind === 'auth'
      ? { anthropic: { type: 'api_key', key: `!touch '${marker}'; printf synthetic` } }
      : { providers: { anthropic: { apiKey: `!touch '${marker}'; printf synthetic`,
        baseUrl: anthropic.baseUrl,
        modelOverrides: { 'claude-sonnet-4-5': { contextWindow: 4096, maxTokens: 512 } } } } };
    const hook = t.mock.method(fsPromises, 'readFile', async (...args: Parameters<typeof originalRead>) => {
      const bytes = await originalRead(...args);
      if (args[0] === target && !substituted) {
        substituted = true;
        await writeFile(target, JSON.stringify(replacement));
      }
      return bytes;
    });
    syncBuiltinESMExports();
    try {
      const result = await runPiSession(provider.config, { task: 'Inspect', constraints: '', hints: [], roots: ['r'] }, [],
        '# smip discovery v1\n', new AbortController().signal, () => {}, fact => observations.push(fact));
      assert.equal(substituted, true);
      await assert.rejects(originalRead(marker), { code: 'ENOENT' });
      if (kind === 'auth') {
        assert.deepEqual(result, { outcome: 'failed', code: 'executableConfiguration' });
        assert.equal(provider.requests.length, 0);
      } else {
        assert.equal(result.outcome, 'complete');
        const preflight = observations.find(fact => fact.kind === 'preflight');
        assert(preflight?.kind === 'preflight');
        assert(preflight.effective);
        assert.equal(preflight.effective.contextWindow, 8192);
        assert.equal(preflight.effective.maxTokens, 1024);
        assert.equal(provider.requests.length, 1);
      }
      await writeFile(join(provider.directory, 'substitution-proof.json'), JSON.stringify({ kind, result, observations }, null, 2));
    } finally {
      hook.mock.restore(); syncBuiltinESMExports(); await provider.close();
    }
    });
  }
});

test('independent SDK credential owners serialize persistent OAuth rotation and reject later commands', async t => {
  const provider = await scriptedProvider(() => { throw new Error('Unexpected inference'); });
  const controller = new AbortController();
  let refreshes = 0;
  let entered!: () => void, release!: () => void;
  const refreshing = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://platform.claude.com/v1/oauth/token');
    assert.equal(JSON.parse(String(init?.body)).refresh_token, 'synthetic-refresh-before');
    refreshes++; entered(); await resume;
    return new Response(JSON.stringify({ access_token: 'synthetic-access-after', refresh_token: 'synthetic-refresh-after', expires_in: 3600 }));
  });
  try {
    await writeFile(provider.config.authPath, JSON.stringify({ anthropic: { type: 'oauth', refresh: 'synthetic-refresh-before', access: 'synthetic-expired', expires: 0 } }));
    const stores = await Promise.all([createCredentials(provider.config.authPath, controller.signal), createCredentials(provider.config.authPath, controller.signal)]);
    const runtimes = await Promise.all(stores.map(credentials => ModelRuntime.create({ credentials, modelsPath: null,
      modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false, signal: controller.signal })));
    const first = runtimes[0]!.getAuth('anthropic', { signal: controller.signal });
    await refreshing;
    const second = runtimes[1]!.getAuth('anthropic', { signal: controller.signal });
    release();
    const resolved = await Promise.all([first, second]);
    assert.equal(refreshes, 1);
    assert(resolved.every(result => result?.auth.apiKey === 'synthetic-access-after'));
    const reopened = await createCredentials(provider.config.authPath, controller.signal);
    const saved = await reopened.read('anthropic');
    assert(saved?.type === 'oauth');
    assert.equal(saved.refresh, 'synthetic-refresh-after');
    assert.equal(saved.access, 'synthetic-access-after');
    const marker = join(provider.directory, 'later-command-executed');
    await writeFile(provider.config.authPath, JSON.stringify({ anthropic: { type: 'api_key', key: `!touch '${marker}'` } }));
    for (const store of [...stores, reopened]) await assert.rejects(store.read('anthropic'), /executableConfiguration/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    controller.abort();
    await assert.rejects(reopened.list());
    await writeFile(join(provider.directory, 'oauth-proof.json'), JSON.stringify({ refreshes, persistedRotation: true, laterCommandsRejected: true, cancellationRejected: true }));
  } finally { release(); controller.abort(); await provider.close(); }
});
