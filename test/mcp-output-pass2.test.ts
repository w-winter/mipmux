import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { getDefaultHighWaterMark } from 'node:stream';
import { test } from 'node:test';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { serveSmipStdio } from '../src/mcp/server.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import { verifyBundle } from '../src/context/verify.js';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';

function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const config = { cachePath: '/unavailable/cache', nativeExecutable: '/unavailable/native', nativeEnvironment: {}, terminationGraceMs: 100,
  contextBudgetUnits: 1000000, credentialPaths: [], search: null, git: null, discovery: null, defaultMaxOutputBytes: 12000 };
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
for (const scenario of ['subscription', 'existing', 'progress', 'outputError', 'cleanupError'] as const) {
  test(`production stdio joins application and cancels ${scenario} output without closing shared stdout`, async t => {
    let wire!: StdioServerTransport;
    t.mock.method(StdioServerTransport.prototype, 'start', async function(this: StdioServerTransport) { wire = this; });
    const originalWrite = process.stdout.write.bind(process.stdout), entered = barrier(), appEntered = barrier(), resumeApp = barrier();
    const sharedErrorListeners = process.stdout.listenerCount('error');
    let hold = false, applicationJoined = false, progressSettled = false;
    const accepted: string[] = [], callbacks: ((error?: Error) => void)[] = [];
    t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...args: unknown[]) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      if (!text.startsWith('{') || !text.includes('"jsonrpc":"2.0"')) return originalWrite(chunk);
      accepted.push(text);
      const callback = args.find(arg => typeof arg === 'function');
      if (hold) { if (typeof callback === 'function') callbacks.push(error => callback(error)); entered.release(); return false; }
      if (typeof callback === 'function') callback();
      return true;
    });
    const register = McpServer.prototype.registerTool;
    let installed = false;
    t.mock.method(McpServer.prototype, 'registerTool', function(this: McpServer, ...args: Parameters<typeof register>) {
      if (!installed) {
        installed = true;
        this.registerTool('held_progress', { description: 'Synthetic progress boundary', inputSchema: fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false }) }, async (_input, ctx) => {
          try { await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'p', progress: 1 } }); }
          finally { progressSettled = true; }
          return { content: [] };
        });
      }
      return register.call(this, ...args);
    });
    t.mock.method(SmipRuntime.prototype, 'close', async () => { appEntered.release(); await resumeApp.promise; applicationJoined = true;
      if (scenario === 'cleanupError') throw new Error('synthetic cleanup secret'); });
    const host = serveSmipStdio(config);
    wire.onmessage?.({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: meta, name: 'context_builder_result', arguments: { jobId: 'absent' } } });
    await turn();
    wire.onmessage?.({ jsonrpc: '2.0', id: 3, method: 'subscriptions/listen', params: { _meta: meta, notifications: { toolsListChanged: true } } });
    await turn();
    assert(accepted.some(text => text.includes('notifications/subscriptions/acknowledged')));
    hold = true;
    let pendingSettled = false;
    let pending: Promise<unknown> | null = null;
    if (scenario === 'progress') {
      pending = wire.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p'.repeat(getDefaultHighWaterMark(false)), progress: 1 } })
        .then(() => { pendingSettled = true; }, () => { pendingSettled = true; });
      wire.onmessage?.({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { _meta: meta, name: 'held_progress', arguments: {} } });
    } else if (scenario !== 'subscription') {
      pending = wire.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p'.repeat(getDefaultHighWaterMark(false)), progress: 1 } })
        .then(() => { pendingSettled = true; }, () => { pendingSettled = true; });
    }
    if (scenario !== 'subscription') { await entered.promise; await turn(); assert.equal(pendingSettled, false); }
    if (scenario === 'progress') assert.equal(progressSettled, false);
    let closed = false;
    const closing = host.close().then(() => { closed = true; }, error => { closed = true; throw error; });
    const observed = scenario === 'cleanupError' || scenario === 'outputError' ? assert.rejects(closing) : closing;
    await appEntered.promise; await turn(); assert.equal(closed, false); assert.equal(applicationJoined, false);
    if (scenario === 'outputError') callbacks.shift()!(new Error('synthetic output secret'));
    resumeApp.release();
    await observed;
    await pending;
    await turn();
    assert.equal(applicationJoined, true);
    if (scenario === 'progress') assert.equal(progressSettled, true);
    if (pending) assert.equal(pendingSettled, true);
    assert.equal(process.stdout.destroyed, false);
    hold = false;
    assert.equal(process.stdout.listenerCount('error'), sharedErrorListeners);
    await new Promise<void>(resolve => originalWrite('shared stdout remains usable\n', () => resolve()));
    // Callback completion after cancellation cannot resurrect a cancelled protocol write.
    callbacks.forEach(callback => callback());
    await mkdir('test-output', { recursive: true }); const directory = await mkdtemp(join(tmpdir(), 'smip-mcp-output-pass2-'));
    await writeFile(join(directory, 'proof.json'), JSON.stringify({ scenario, applicationJoined, progressSettled, pendingSettled, sharedStdoutOpen: !process.stdout.destroyed,
      subscriptionAcknowledged: true, acceptedRecords: accepted.length }) + '\n');
  });
}

test('production stdio shutdown waits for real claimed publication before closing output', async t => {
  await mkdir('test-output', { recursive: true }); const directory = await mkdtemp(join(tmpdir(), 'smip-mcp-publication-pass2-'));
  const root = join(directory, 'root'), out = join(directory, 'out'); await mkdir(root); await mkdir(out); await writeFile(join(root, 'file.txt'), 'body');
  const published = barrier(), resume = barrier();
  const originalRequest = BridgeClient.prototype.request;
  t.mock.method(BridgeClient.prototype, 'request', async function(this: BridgeClient, ...args: Parameters<typeof originalRequest>) {
    if (args[0].kind === 'publishManifest') { published.release(); await resume.promise; }
    return originalRequest.call(this, ...args);
  });
  let wire!: StdioServerTransport;
  t.mock.method(StdioServerTransport.prototype, 'start', async function(this: StdioServerTransport) { wire = this; });
  const originalWrite = process.stdout.write.bind(process.stdout), responses = new Map<number, (value: unknown) => void>();
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...args: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    if (!text.startsWith('{') || !text.includes('"jsonrpc":"2.0"')) return originalWrite(chunk);
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'number') {
      responses.get(value.id)?.(value); responses.delete(value.id);
    }
    const callback = args.find(arg => typeof arg === 'function'); if (typeof callback === 'function') callback(); return true;
  });
  const host = serveSmipStdio({ ...config, cachePath: join(directory, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`) });
  let id = 0;
  const call = async (name: string, args: unknown) => {
    const requestId = ++id;
    const result = new Promise<unknown>(resolve => responses.set(requestId, resolve));
    wire.onmessage?.({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { _meta: meta, name, arguments: args } });
    const value = await result;
    assert(value && typeof value === 'object' && 'result' in value);
    const body = value.result; assert(body && typeof body === 'object' && 'structuredContent' in body);
    return body.structuredContent;
  };
  try {
    const workspace = await call('workspace_declare', { spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out } });
    assert(workspace && typeof workspace === 'object' && 'id' in workspace);
    const draft = await call('draft_create', { workspaceId: workspace.id, request: { task: 'Task', duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'augment' as const, purpose: 'review',
      requiredSources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } }], documents: [], patches: [], discoveryHints: [], outputName: 'packet',
      budgetUnits: 10000 } });
    assert(draft && typeof draft === 'object' && 'id' in draft);
    await call('draft_update', { draftId: draft.id, input: { expectedRevision: 0, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify({ clarifiedTask: 'Task', architecture: 'Files', relationships: [], ambiguities: [] }) } } });
    wire.onmessage?.({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { _meta: meta, name: 'draft_finalize', arguments: { draftId: draft.id } } });
    await published.promise;
    let closed = false; const closing = host.close().then(() => { closed = true; });
    await turn(); assert.equal(closed, false);
    resume.release(); await closing; await host.closed;
    const verified = await verifyBundle(join(out, 'packet'));
    assert.equal(process.stdout.destroyed, false);
    await writeFile(join(directory, 'proof.json'), JSON.stringify({ claimedPublicationJoined: true, files: verified.manifest.files }) + '\n');
  } finally { resume.release(); await host.close(); }
});
