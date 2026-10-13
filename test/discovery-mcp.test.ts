import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { verifyBundle } from '../src/index.js';
import { compose } from '../src/cli/config.js';
import type { DiscoveryInput } from '../src/discovery/runner.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import { toolSchemas } from '../src/contracts/discovery.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import { controlledHttpMcp } from './fixtures/controlled-http-mcp.js';

async function configure(directory: string, url: string) {
  const agentDirectory = join(directory, 'scout-mcp'); await mkdir(agentDirectory, { mode: 0o700 });
  await writeFile(join(agentDirectory, 'mcp.json'), JSON.stringify({ mcpServers: { controlled: {
    url, exposure: 'hidden', toolExposure: { read_ticket: 'direct' },
    headers: { Authorization: 'Bearer synthetic$$$!mcp-token' },
  } } }));
  return { agentDirectory };
}

test('native HTTP reads add complete fetched documents to a verified packet while forbidden tools stay unreachable', async t => {
  const server = await controlledHttpMcp();
  t.after(() => server.close());
  const provider = await scriptedProvider((_summary, index) => {
    const names = ['mcp__controlled__read_ticket', 'mcp__controlled__delete_ticket', 'codemode', 'tool_search', 'list_mcp_resources'];
    if (index <= names.length) return { kind: 'tool', name: names[index - 1]!, input: {}, stop: 'tool_use', tokens: 10 };
    if (index === 6) {
      assert(JSON.stringify(provider.requests.at(-1)?.messages).includes('Ticket: repair the discovery worker'));
      assert(JSON.stringify(provider.requests.at(-1)?.messages).includes('FETCHED_DOCUMENT_END'));
      return { kind: 'tool', name: 'draft_update', input: { expectedRevision: 0, maxOutputBytes: 10000,
        mutation: { kind: 'addDocument', document: { kind: 'suppliedDocument', id: 'fetched-ticket', role: 'evidence',
          origin: server.url, text: server.text } } }, stop: 'tool_use', tokens: 10 };
    }
    if (index === 7) return { kind: 'tool', name: 'draft_update', input: { expectedRevision: 1, maxOutputBytes: 10000,
        mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify({ clarifiedTask: 'Repair the discovery worker', architecture: 'Ticket: repair the discovery worker',
          relationships: [], ambiguities: [] }) } }, stop: 'tool_use', tokens: 10 };
    if (index === 8) return { kind: 'tool', name: 'draft_validate', input: { maxOutputBytes: 10000 }, stop: 'tool_use', tokens: 10 };
    return { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 };
  });
  t.after(() => provider.close());
  const ambientHome = join(provider.directory, 'ambient-home'); await mkdir(ambientHome);
  provider.config.environment = { HOME: ambientHome, TMPDIR: ambientHome };
  const mcp = await configure(provider.directory, server.url);
  const root = join(provider.directory, 'root'), output = join(provider.directory, 'out');
  await mkdir(root); await mkdir(output); await writeFile(join(root, 'file.txt'), 'Source evidence\n');
  const discovery = { ...provider.config, mcp };
  const { runtime, client } = compose({ cachePath: join(provider.directory, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    discovery, search: null, git: null, defaultMaxOutputBytes: 10000 }, null);
  const spawn = runtime.supervisor.spawn.bind(runtime.supervisor);
  let workerEnvironment: Readonly<Record<string, string>> | null = null;
  t.mock.method(runtime.supervisor, 'spawn', (spec: Parameters<typeof spawn>[0]) => {
    if (spec.args.some(argument => argument.endsWith('/pi-worker.js'))) workerEnvironment = spec.env;
    return spawn(spec);
  });
  try {
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] }, new AbortController().signal);
    const job = client.build(workspace.id, 'mcp', { task: 'Inspect the ticket', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation',
      requiredSources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } }], documents: [], patches: [], discoveryHints: [], outputName: 'packet',
      budgetUnits: 10000 });
    const result = await client.wait(job.jobId, 10000, new AbortController().signal, () => {});
    assert.equal(result.state, 'ready', JSON.stringify(result)); assert(result.state === 'ready');
    const verified = await verifyBundle(result.bundle.directory), packet = await readFile(join(result.bundle.directory, 'context.md'));
    assert.equal(verified.manifest.request.documents.length, 0);
    const document = verified.manifest.materials.find(material => material.id === 'document:fetched-ticket');
    assert(document?.kind === 'document');
    assert.deepEqual(document.input, { kind: 'suppliedDocument', id: 'fetched-ticket', role: 'evidence', origin: server.url, text: server.text });
    assert.equal(document.spans.length, 1);
    const span = document.spans[0]; assert(span);
    assert.deepEqual(packet.subarray(span.offset, span.offset + span.length), Buffer.from(server.text));
    assert.equal(result.discovery.mcp?.readiness.state, 'ready'); assert.equal(result.discovery.mcp?.shutdown, 'dispatched');
    assert.deepEqual(result.discovery.mcp?.servers.map(server => ({ name: server.name, tools: server.tools })), [{ name: 'controlled', tools: ['read_ticket'] }]);
    assert(workerEnvironment);
    for (const name of ['HOME', 'TMPDIR', 'PI_CODING_AGENT_DIR']) assert.equal(workerEnvironment[name], mcp.agentDirectory);
    await assert.rejects(access(join(ambientHome, '.pi')), { code: 'ENOENT' });
    assert.deepEqual(server.calls, ['read_ticket']);
    for (const request of provider.requests) assert.deepEqual(request.tools.sort(), [...Object.keys(toolSchemas), 'mcp__controlled__read_ticket'].sort());
    assert(JSON.stringify(provider.requests).includes('not found'));
    assert(!JSON.stringify({ result, requests: provider.requests }).includes('synthetic$!mcp-token'));
    await writeFile(join(provider.directory, 'transcript.json'), JSON.stringify({ requests: provider.requests, calls: server.calls }, null, 2));
    await writeFile(join(provider.directory, 'terminal-receipt.json'), JSON.stringify(result, null, 2));
    await writeFile(resolve('test-output/discovery-mcp-proof.json'), JSON.stringify({ directory: provider.directory }));
  } finally { await runtime.close(); }
});

test('missing selected tools, unavailable servers and authentication failure stop provider dispatch', async () => {
  for (const scenario of ['missing', 'unauthorized', 'unavailable'] as const) {
    const server = await controlledHttpMcp(); server.state[scenario] = true;
    const provider = await scriptedProvider(() => { throw new Error('No model permitted'); });
    const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
    try {
      const mcp = await configure(provider.directory, server.url);
      const discovery = { ...provider.config, mcp };
      const result = await new PiRunner(discovery, supervisor).run({ tokenBudget: 10000, enhancementMode: 'fullRewrite' as const, task: 'Inspect', purpose: 'investigation', initialContext: 'Fixture context', constraints: '', hints: [], roots: [] },
        { call: async () => { throw new Error('No parent tool permitted'); } }, new AbortController().signal, () => {});
      assert.equal(result.kind, 'failed'); assert(result.kind === 'failed'); assert.equal(result.code, 'mcpToolsUnavailable');
      assert.equal(result.receipt.mcp?.readiness.state, 'unavailable'); assert.equal(result.receipt.mcp?.shutdown, 'dispatched');
      assert.equal(provider.requests.length, 0); assert.equal(result.receipt.workerClosed, true);
    } finally { await supervisor.close(); await provider.close(); await server.close(); }
  }
});

test('cancellation during MCP startup or a held call closes the worker and permits the next run', async () => {
  for (const hold of ['initialize', 'read_ticket'] as const) {
    const server = await controlledHttpMcp(); server.state.hold = hold;
    const provider = await scriptedProvider((_summary, index) => index === 1
      ? { kind: 'tool', name: 'mcp__controlled__read_ticket', input: {}, stop: 'tool_use', tokens: 10 }
      : { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 });
    const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 }), abort = new AbortController();
    try {
      const mcp = await configure(provider.directory, server.url), discovery = { ...provider.config, mcp };
      const runner = new PiRunner(discovery, supervisor);
      const tools = { call: async () => { throw new Error('No parent tool permitted'); } };
      const input: DiscoveryInput = { tokenBudget: 10000, enhancementMode: 'fullRewrite' as const, task: 'Inspect', purpose: 'investigation', initialContext: 'Fixture context', constraints: '', hints: [], roots: [] };
      const work = runner.run(input, tools, abort.signal, () => {});
      await server.held; abort.abort();
      const cancelled = await work; assert.equal(cancelled.kind, 'cancelled');
      await server.heldClosed;
      assert.equal(cancelled.receipt.workerClosed, true); assert.equal(cancelled.receipt.parentToolsSettled, true);
      if (hold === 'initialize') assert.equal(provider.requests.length, 0);
      server.state.hold = null;
      const next = await runner.run(input, tools, new AbortController().signal, () => {});
      assert.equal(next.kind, 'complete', JSON.stringify(next));
      await writeFile(join(provider.directory, 'cancellation-receipts.json'), JSON.stringify({ cancelled, next }, null, 2));
    } finally { await supervisor.close(); await provider.close(); await server.close(); }
  }
});
