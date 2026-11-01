import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { DiscoveryHostConfig } from '../../src/discovery/selection.js';
import type { DiscoveryConfig } from '../../src/discovery/discovery-config.js';

const requestValidator = Compile(Type.Object({ model: Type.String(), messages: Type.Array(Type.Unknown()),
  tools: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))), system: Type.Optional(Type.Unknown()) }));
export type Reply = { kind: 'error' } | { kind: 'overflow' } | { kind: 'hold'; entered: () => void } |
  { kind: 'text'; text: string; stop: 'end_turn' | 'max_tokens'; tokens: number; reportedModel?: string } |
  { kind: 'tool'; name: string; input: unknown; stop: 'tool_use' | 'max_tokens'; tokens: number };

/** A host configuration's discovery settings for a Pi runner configuration such as `scriptedProvider` returns. */
export function hostDiscovery(config: DiscoveryHostConfig): DiscoveryConfig {
  const { modelsPath, authPath, environment, codemode, policy, ...shared } = config;
  return { ...shared, pi: { modelsPath, authPath, environment, codemode, policy }, claudeCode: null };
}

export async function scriptedProvider(respond: (summary: boolean, index: number) => Reply) {
  const requests: { model: string; tools: string[]; summary: boolean; messages: unknown[]; system: unknown }[] = [];
  const server = createServer(async (request, response) => {
    const bytes: Buffer[] = []; for await (const chunk of request) bytes.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(bytes).toString());
    if (!requestValidator.Check(body)) { response.writeHead(400); response.end(); return; }
    const summary = !body.tools?.length;
    requests.push({ model: body.model, tools: body.tools?.map(tool => tool.name) ?? [], summary, messages: body.messages, system: body.system });
    const reply = respond(summary, requests.length);
    if (reply.kind === 'hold') { reply.entered(); return; }
    if (reply.kind === 'error' || reply.kind === 'overflow') {
      response.writeHead(reply.kind === 'error' ? 529 : 400);
      response.end(JSON.stringify({ type: 'error', error: { type: reply.kind === 'error' ? 'overloaded_error' : 'invalid_request_error',
        message: reply.kind === 'error' ? 'Overloaded' : 'prompt is too long: 10000 tokens > 8192 maximum' } })); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit('message_start', { type: 'message_start', message: { id: 'synthetic-' + requests.length, type: 'message', role: 'assistant', model: reply.kind === 'text' ? reply.reportedModel ?? body.model : body.model,
      content: [], stop_reason: null, usage: { input_tokens: reply.tokens, output_tokens: 0 } } });
    emit('content_block_start', { type: 'content_block_start', index: 0, content_block: reply.kind === 'text'
      ? { type: 'text', text: '' } : { type: 'tool_use', id: 'tool-' + requests.length, name: reply.name, input: {} } });
    emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: reply.kind === 'text'
      ? { type: 'text_delta', text: reply.text } : { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) } });
    emit('content_block_stop', { type: 'content_block_stop', index: 0 });
    emit('message_delta', { type: 'message_delta', delta: { stop_reason: reply.stop, stop_sequence: null }, usage: { output_tokens: 4 } });
    emit('message_stop', { type: 'message_stop' }); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'mipmux-scripted-pi-'));
  const config: DiscoveryHostConfig = { provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', allowedModels: [],
    authPath: join(directory, 'auth.json'), modelsPath: join(directory, 'models.json'), promptTemplatePath: join(directory, 'discovery.md'), environment: {}, mcp: null, codemode: true,
    policy: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0, maxAgentDelayMs: 0,
      provider: { timeoutMs: 10000, maxRetries: 0, maxRetryDelayMs: 0 } },
      compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 128 },
      transport: 'sse', httpIdleTimeoutMs: 10000, websocketConnectTimeoutMs: 1000, cacheWarming: 'off' } };
  await writeFile(config.promptTemplatePath, await readFile(resolve('test/fixtures/discovery-template.md'), 'utf8'));
  await writeFile(config.authPath, JSON.stringify({ anthropic: { type: 'api_key', key: 'synthetic' } }));
  await writeFile(config.modelsPath, JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${address.port}`,
    modelOverrides: { 'claude-sonnet-4-5': { contextWindow: 8192, maxTokens: 1024 } } } } }));
  return { config, directory, requests, url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
