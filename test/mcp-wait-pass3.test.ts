import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getDefaultHighWaterMark } from 'node:stream';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { serveSmipStdio } from '../src/mcp/server.js';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import type { ClientRuntime } from '../src/runtime/client-runtime.js';
import type { DiscoveryRunner } from '../src/discovery/runner.js';
import type { DiscoveryEvent } from '../src/contracts/discovery.js';

function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
for (const scenario of ['timeout', 'abort'] as const) {
  test(`production wait settles independently of held progress: ${scenario}`, async t => {
    await mkdir('test-output', { recursive: true }); const directory = await mkdtemp(join(tmpdir(), 'smip-mcp-wait-pass3-'));
    const root = join(directory, 'root'), out = join(directory, 'out'); await mkdir(root); await mkdir(out); await writeFile(join(root, 'file.txt'), 'source');
    const running = barrier(), aborted = barrier(), releaseRunner = barrier(), waitEntered = barrier(), outputEntered = barrier();
    let progress!: (event: DiscoveryEvent) => void;
    const runner: DiscoveryRunner = { run: async (_input, _tools, signal, notify) => {
      progress = notify; running.release();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      aborted.release(); await releaseRunner.promise; throw new Error('Cancelled runner boundary');
    } };
    let client!: ClientRuntime;
    const createClient = SmipRuntime.prototype.createClient;
    t.mock.method(SmipRuntime.prototype, 'createClient', function(this: SmipRuntime) {
      client = createClient.call(this, runner); return client;
    });
    let handlerSettled = false, handlerResult: unknown;
    const register = McpServer.prototype.registerTool;
    t.mock.method(McpServer.prototype, 'registerTool', function(this: McpServer, ...args: Parameters<typeof register>) {
      const [name, options, callback] = args;
      if (name !== 'context_builder_wait') return register.call(this, ...args);
      return register.call(this, name, options, async (input, ctx) => {
        waitEntered.release();
        try { const result = await callback(input, ctx); handlerResult = result; return result; }
        finally { handlerSettled = true; }
      });
    });
    let wire!: StdioServerTransport;
    t.mock.method(StdioServerTransport.prototype, 'start', async function(this: StdioServerTransport) { wire = this; });
    const originalWrite = process.stdout.write.bind(process.stdout), responses = new Map<number, (value: unknown) => void>();
    const callbacks: ((error?: Error) => void)[] = [];
    let hold = false;
    t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...args: unknown[]) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      if (!text.startsWith('{') || !text.includes('"jsonrpc":"2.0"')) return originalWrite(chunk);
      const callback = args.find(arg => typeof arg === 'function');
      if (hold) { if (typeof callback === 'function') callbacks.push(error => callback(error)); outputEntered.release(); return false; }
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'number') responses.get(value.id)?.(value);
      if (typeof callback === 'function') callback(); return true;
    });
    const host = serveSmipStdio({ copyContext: copyContext(), cachePath: join(directory, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
      nativeEnvironment: {}, contextBudgetUnits: 1000000, credentialPaths: [], terminationGraceMs: 100, git: null, discovery: null, defaultMaxOutputBytes: 12000 });
    let id = 0;
    const call = async (name: string, args: unknown) => {
      const requestId = ++id, result = new Promise<unknown>(resolve => responses.set(requestId, resolve));
      wire.onmessage?.({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { _meta: meta, name, arguments: args } });
      const value = await result; assert(value && typeof value === 'object' && 'result' in value);
      const body = value.result; assert(body && typeof body === 'object' && 'structuredContent' in body); return body.structuredContent;
    };
    try {
      const workspace = await call('workspace_declare', { spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out } });
      assert(workspace && typeof workspace === 'object' && 'id' in workspace);
      const job = await call('context_builder', { workspaceId: workspace.id, requestId: 'one', request: { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation',
        requiredSources: [], documents: [], patches: [], discoveryHints: [], outputName: 'packet',
        budgetUnits: 10000 } });
      assert(job && typeof job === 'object' && 'jobId' in job && typeof job.jobId === 'string'); await running.promise;
      hold = true; const waitId = ++id;
      wire.onmessage?.({ jsonrpc: '2.0', id: waitId, method: 'tools/call', params: { _meta: { ...meta, progressToken: 'p'.repeat(getDefaultHighWaterMark(false)) },
        name: 'context_builder_wait', arguments: { jobId: job.jobId, durationMs: scenario === 'abort' ? 2147483647 : 30 } } });
      await waitEntered.promise;
      progress({ kind: 'boundary', attempt: null, delayMs: null, success: null, reason: null }); await outputEntered.promise;
      if (scenario === 'abort') wire.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: waitId } });
      // Allow the local timer or cancellation to run while the output callback stays held.
      await delay(100);
      const independentlySettled = handlerSettled, active = client.result(job.jobId);
      assert.equal(active.state, 'discovering'); assert.equal(active.localSettled, false);
      let closed = false; const closing = host.close().finally(() => { closed = true; });
      await aborted.promise; await turn(); assert.equal(closed, false);
      releaseRunner.release(); await closing; await turn();
      assert.equal(handlerSettled, true); assert.equal(process.stdout.destroyed, false);
      hold = false; callbacks.forEach(callback => callback());
      await new Promise<void>(resolve => originalWrite('wait regression shared stdout remains usable\n', () => resolve()));
      await writeFile(join(directory, 'proof.json'), JSON.stringify({ scenario, independentlySettled, handlerResult, active,
        applicationJoined: true, sharedStdoutOpen: !process.stdout.destroyed }) + '\n');
      assert.equal(independentlySettled, true);
      assert(handlerResult && typeof handlerResult === 'object' && 'structuredContent' in handlerResult);
      const body = handlerResult.structuredContent; assert(body && typeof body === 'object');
      if (scenario === 'abort') { assert('code' in body); assert.equal(body.code, 'cancelled'); }
      else assert.deepEqual(body, active);
    } finally { releaseRunner.release(); await host.close().catch(() => {}); }
  });
}
