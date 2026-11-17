import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { waitForSettlement } from './fixtures/wait-for-settlement.js';

const regressionTimeoutMs = 5000;
const heldWaitDeadlineMs = 100;

for (const scenario of ['deadline', 'abort', 'tool-error'] as const) {
  test(`package job wait reports its last reply on ${scenario}`, { timeout: regressionTimeoutMs }, async t => {
    const server = new McpServer({ name: 'held-job', version: '1' });
    const client = new Client({ name: 'package-wait', version: '1' });
    const abort = new AbortController();
    const jobId = 'held-package-job';
    const snapshot = { jobId, state: 'discovering', localSettled: false };
    const failure = { kind: 'failed', code: 'unknownJob' };
    let calls = 0;
    server.registerTool('context_job', { inputSchema: fromJsonSchema({ type: 'object' }) }, async (_input, ctx): Promise<CallToolResult> => {
      if (++calls === 1) return { content: [{ type: 'text', text: JSON.stringify(snapshot) }] };
      if (scenario === 'tool-error') return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }] };
      if (scenario === 'abort') abort.abort(new Error('cancel package verification'));
      await new Promise<void>(resolve => {
        if (ctx.mcpReq.signal.aborted) resolve();
        else ctx.mcpReq.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { content: [{ type: 'text', text: JSON.stringify(snapshot) }] };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(serverTransport); await client.connect(clientTransport);
    const signal = scenario === 'deadline' ? AbortSignal.timeout(heldWaitDeadlineMs) : abort.signal;
    let diagnostic = '';
    await assert.rejects(waitForSettlement(client, jobId, signal), (error: Error) => {
      assert(error instanceof Error);
      diagnostic = error.message;
      assert(diagnostic.includes(jobId), diagnostic);
      assert(diagnostic.includes(JSON.stringify(scenario === 'tool-error' ? failure : snapshot)), diagnostic);
      assert(error.cause instanceof Error);
      return true;
    });
    assert(calls >= 2);
    await mkdir('test-output', { recursive: true });
    await writeFile(`test-output/package-wait-${scenario}.json`, JSON.stringify({ scenario, calls, diagnostic }) + '\n');
  });
}
