import { nativeDiscoveryRenderer } from './fixtures/render-discovery-prompt.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import { selectDiscovery, type DiscoveryHostConfig } from '../src/discovery/selection.js';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const catalogModel = 'deepseek-flash', servedModel = 'DeepSeek-V4.1-Flash-1017';
/** A TCP server's address; `server.address()` returns a string only for pipes and sockets. */
const tcpAddress = Compile(Type.Object({ port: Type.Integer() }));
/** A retryable failure with no stream, or a tool call or final text whose chunks name `model`, or no model when it is null. */
type Reply = { kind: 'unavailable' } | { kind: 'tool' | 'text'; model: string | null };

/**
 * A local OpenAI chat-completions endpoint standing in for a self-hosted `deepseek/deepseek-flash`, answering request `n`
 * with `replies[n]`, and a Pi discovery configuration that uses it, with the models file declaring `expectedServerModel`.
 */
async function openAIProvider(replies: readonly Reply[], expectedServerModel: string | null) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* The reply does not depend on the request body. */ }
    const reply = replies[requests++];
    if (!reply) { response.writeHead(400); response.end(); return; }
    if (reply.kind === 'unavailable') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Service unavailable' } })); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = reply.kind === 'tool' ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + requests, type: 'function',
      function: { name: 'draft_inspect', arguments: JSON.stringify({ view: 'metadata', maxOutputBytes: 10000, continuation: null }) } }] }
      : { role: 'assistant', content: 'Complete' };
    const chunk = { id: 'response-' + requests, object: 'chat.completion.chunk', created: 1, ...reply.model !== null && { model: reply.model } };
    response.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: reply.kind === 'tool' ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!tcpAddress.Check(address)) throw new Error('Missing port');
  const directory = await mkdtemp(join(tmpdir(), 'mipmux-served-model-'));
  const config: DiscoveryHostConfig = { provider: 'deepseek', model: catalogModel, thinking: 'high', allowedModels: [],
    authPath: join(directory, 'auth.json'), modelsPath: join(directory, 'models.json'), promptTemplatePath: join(directory, 'discovery.md'),
    environment: {}, mcp: null, codemode: false,
    policy: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0, maxAgentDelayMs: 0, provider: { timeoutMs: 10000, maxRetries: 0, maxRetryDelayMs: 0 } },
      compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 128 },
      transport: 'sse', httpIdleTimeoutMs: 10000, websocketConnectTimeoutMs: 1000, cacheWarming: 'off' } };
  await writeFile(config.promptTemplatePath, await readFile(resolve('test/fixtures/discovery-template.md'), 'utf8'));
  await writeFile(config.authPath, JSON.stringify({ deepseek: { type: 'api_key', key: 'synthetic' } }));
  await writeFile(config.modelsPath, JSON.stringify({ providers: { deepseek: { baseUrl: `http://127.0.0.1:${address.port}`,
    modelOverrides: { [catalogModel]: { contextWindow: 8192, maxTokens: 1024, ...expectedServerModel !== null && { expectedServerModel } } } } } }));
  return { config, directory, url: `http://127.0.0.1:${address.port}`, requests: () => requests, close: async () => {
    server.closeAllConnections(); await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  } };
}

/** Runs Pi discovery with this configuration, answering every mipmux tool call with the same metadata. */
async function discover(config: DiscoveryHostConfig) {
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  try {
    return await new PiRunner(config, supervisor, nativeDiscoveryRenderer(supervisor)).run({ tokenBudget: 10000, enhancementMode: 'fullRewrite',
      task: 'Task', purpose: 'investigation', initialContext: 'Fixture context', fileTree: '', currentPrompt: 'Fixture message',
      restrictsReviewGitToExplicitReadOnly: true, constraints: '', hints: [], roots: ['r'] },
      { call: async () => ({ kind: 'metadata', body: 'data' }) }, new AbortController().signal, () => {}, selectDiscovery(config, undefined));
  } finally { await supervisor.close(); }
}

test('discovery stops at the first response whose server names an unexpected model, and accepts a declared served model', async () => {
  const tool = (model: string | null): Reply => ({ kind: 'tool', model }), text: Reply = { kind: 'text', model: servedModel };
  const scenarios = [
    // The reported case: no declaration, and the endpoint names its own model.
    { name: 'undeclared', declared: null, replies: [tool(servedModel)], code: 'modelIdentityMismatch',
      reported: [servedModel, null] },
    { name: 'declared', declared: servedModel, replies: [tool(servedModel), text], code: null, reported: [servedModel, [servedModel]] },
    { name: 'catalog', declared: servedModel, replies: [tool(catalogModel)], code: 'modelIdentityMismatch', reported: [null, [catalogModel]] },
    { name: 'unreported', declared: servedModel, replies: [tool(null)], code: 'modelIdentityUnavailable', reported: [null, []] },
    // A failed response that named no model is retried, not refused.
    { name: 'retried', declared: servedModel, replies: [{ kind: 'unavailable' }, tool(servedModel), text], code: null, reported: [null, []] },
  ] as const;
  for (const scenario of scenarios) {
    const provider = await openAIProvider(scenario.replies, scenario.declared);
    try {
      const result = await discover(provider.config);
      const label = scenario.name + JSON.stringify(result);
      assert.equal(result.kind, scenario.code === null ? 'complete' : 'failed', label);
      if (result.kind === 'failed') assert.equal(result.code, scenario.code, label);
      assert.equal(provider.requests(), scenario.replies.length, label);
      assert.equal(result.receipt.workerClosed, true, label);
      assert.equal(result.receipt.effective?.expectedServerModel, scenario.declared, label);
      const first = result.receipt.completions[0];
      assert.deepEqual([first?.serverModel, first?.reportedServerModels], scenario.reported, label);
      if (scenario.code === null) {
        assert.deepEqual(result.receipt.completions.filter(completion => completion.stopReason !== 'error')
          .map(completion => completion.reportedServerModels), [[servedModel], [servedModel]], label);
      }
      await writeFile(join(provider.directory, 'receipt.json'), JSON.stringify(result, null, 2));
    } finally { await provider.close(); }
  }
});

test('a served model declared for a model of another API than OpenAI chat completions is refused before any request', async () => {
  const provider = await openAIProvider([], servedModel);
  // The discovery model stays on the local endpoint, so a missed refusal reaches it and is counted, never a public API.
  await writeFile(provider.config.modelsPath, JSON.stringify({ providers: { deepseek: { baseUrl: provider.url },
    anthropic: { modelOverrides: { 'claude-sonnet-5-5': { expectedServerModel: servedModel } } } } }));
  try {
    const result = await discover(provider.config);
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.equal(result.code, 'unsupportedModelConfiguration');
    assert.equal(result.receipt.acceptedRuns, 0);
    assert.equal(provider.requests(), 0);
  } finally { await provider.close(); }
});
