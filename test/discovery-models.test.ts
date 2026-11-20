import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getBuiltinModelDataGeneratedAt } from '@earendil-works/pi-ai/providers/all';
import { listDiscoveryModels } from '../src/discovery/discovery-models.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import { nativeDiscoveryRenderer } from './fixtures/render-discovery-prompt.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';

const input = { tokenBudget: 10000, enhancementMode: 'fullRewrite', task: 'Inspect', purpose: 'investigation',
  initialContext: 'Fixture context', fileTree: '', currentPrompt: 'Fixture message', restrictsReviewGitToExplicitReadOnly: true,
  constraints: '', hints: [], roots: ['r'] } as const;
const tools = { call: async () => { throw new Error('Unexpected tool'); } };

test('the model listing and discovery use Pi\'s refreshed catalog beside auth.json, with mipmux overrides', async t => {
  const provider = await scriptedProvider(() => ({ kind: 'text', text: 'Complete.', stop: 'end_turn', tokens: 10 }));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  try {
    const runtime = await ModelRuntime.create({ authPath: provider.config.authPath, modelsPath: null, refreshOnCreate: false });
    const bundled = runtime.getPhysicalModel('anthropic', provider.config.model);
    assert(bundled);
    const generatedAt = getBuiltinModelDataGeneratedAt();
    assert(generatedAt !== undefined);
    const model = 'claude-sonnet-catalog-test';
    assert.equal(runtime.getPhysicalModel('anthropic', model), undefined);
    const storePath = join(provider.directory, 'models-store.json');
    await writeFile(storePath, JSON.stringify({ anthropic: { models: [{ ...bundled, id: model }], lastModified: generatedAt + 1 } }));
    const stored = await readFile(storePath, 'utf8');
    const configDirectory = join(provider.directory, 'mipmux');
    await mkdir(configDirectory);
    provider.config.modelsPath = join(configDirectory, 'models.json');
    provider.config.model = model;
    provider.config.policy.compaction.enabled = false;
    await writeFile(provider.config.modelsPath, JSON.stringify({ providers: { anthropic: { baseUrl: provider.url,
      modelOverrides: { [model]: { contextWindow: 8192, maxTokens: 1024 } } } } }));
    const runner = new PiRunner(provider.config, supervisor, nativeDiscoveryRenderer(supervisor));
    const models = await runner.listModels(new AbortController().signal);
    assert(models.includes(`anthropic/${model}`));
    assert(models.every(reference => reference.startsWith('anthropic/')));
    const result = await runner.run(input, tools, new AbortController().signal, () => {}, runner.settings(undefined));
    assert.equal(result.kind, 'complete', JSON.stringify(result));
    assert.equal(result.receipt.effective?.identity.model, model);
    assert.equal(result.receipt.effective?.contextWindow, 8192);
    assert.equal(result.receipt.effective?.maxTokens, 1024);
    assert.deepEqual(provider.requests.map(request => request.model), [model]);
    assert.equal(await readFile(storePath, 'utf8'), stored);
    const artifact = join(provider.directory, 'catalog-receipt.json');
    await writeFile(artifact, JSON.stringify({ models, result }, null, 2));
    t.diagnostic(`Catalog and discovery receipt: ${artifact}`);
  } finally { await supervisor.close(); await provider.close(); }
});

test('an unreadable Pi catalog fails listing and discovery before a model request', async () => {
  const provider = await scriptedProvider(() => { throw new Error('Unexpected inference'); });
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  try {
    await writeFile(join(provider.directory, 'models-store.json'), '{ "anthropic":');
    const runner = new PiRunner(provider.config, supervisor, nativeDiscoveryRenderer(supervisor));
    await assert.rejects(runner.listModels(new AbortController().signal), { code: 'modelCatalogReadFailed' });
    const result = await runner.run(input, tools, new AbortController().signal, () => {}, runner.settings(undefined));
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.equal(result.code, 'modelCatalogReadFailed');
    assert.equal(provider.requests.length, 0);
  } finally { await supervisor.close(); await provider.close(); }
});

test('cached model headers cannot execute commands during discovery', async () => {
  const provider = await scriptedProvider(() => ({ kind: 'text', text: 'Complete.', stop: 'end_turn', tokens: 10 }));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  try {
    const runtime = await ModelRuntime.create({ authPath: provider.config.authPath, modelsPath: null, refreshOnCreate: false });
    const model = runtime.getPhysicalModel('anthropic', provider.config.model);
    assert(model);
    const generatedAt = getBuiltinModelDataGeneratedAt();
    assert(generatedAt !== undefined);
    const marker = join(provider.directory, 'command-executed');
    await writeFile(join(provider.directory, 'models-store.json'), JSON.stringify({ anthropic: {
      models: [{ ...model, headers: { 'x-test': `!touch '${marker}'; printf synthetic` } }], lastModified: generatedAt + 1,
    } }));
    const runner = new PiRunner(provider.config, supervisor, nativeDiscoveryRenderer(supervisor));
    const result = await runner.run(input, tools, new AbortController().signal, () => {}, runner.settings(undefined));
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.equal(result.code, 'executableConfiguration');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(provider.requests.length, 0);
    await assert.rejects(runner.listModels(new AbortController().signal), { code: 'executableConfiguration' });
  } finally { await supervisor.close(); await provider.close(); }
});

test('cancelling catalog restoration rejects the model listing', async t => {
  const provider = await scriptedProvider(() => { throw new Error('Unexpected inference'); });
  const controller = new AbortController();
  const storePath = join(provider.directory, 'models-store.json');
  await writeFile(storePath, '{}');
  const originalRead = fs.readFileSync;
  let readCatalog = false;
  const hook = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof originalRead>) => {
    const bytes = originalRead(...args);
    if (args[0] === storePath) { readCatalog = true; controller.abort(); }
    return bytes;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(listDiscoveryModels(provider.config, controller.signal), { name: 'AbortError' });
    assert(readCatalog);
    assert.equal(provider.requests.length, 0);
  } finally { hook.mock.restore(); syncBuiltinESMExports(); await provider.close(); }
});
