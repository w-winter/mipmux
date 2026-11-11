import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { verifyBundle } from '../src/index.js';
import { compose } from '../src/cli/config.js';
import { toolSchemas, type ClaudeCodeDiscoveryReceipt, type DiscoverySelection } from '../src/contracts/discovery.js';
import type { DiscoveryConfig } from '../src/discovery/discovery-config.js';
import type { JobSnapshot } from '../src/contracts/jobs.js';
import { controlledHttpMcp } from './fixtures/controlled-http-mcp.js';
import { scriptedProvider, type Reply } from './fixtures/scripted-provider.js';

const model = 'claude-sonnet-5-5';
const toolNames = Object.keys(toolSchemas).filter(name => name !== 'ask_user');
const bareToolMention = new RegExp('`(' + Object.keys(toolSchemas).join('|') + ')`|"tool":"(' + Object.keys(toolSchemas).join('|') + ')"');
const RecordedMessages = Type.Array(Type.Object({ role: Type.String(), content: Type.Union([Type.String(), Type.Array(Type.Object({ type: Type.String(),
  cache_control: Type.Optional(Type.Object({ type: Type.String() })) }))]) }));
const recordedMessages = Compile(RecordedMessages);
/** A request's recorded messages, checked without `Parse`, which would drop the fields the schema does not name, such as text. */
function recorded(messages: unknown[]): Static<typeof RecordedMessages> {
  assert(recordedMessages.Check(messages));
  return messages;
}

/**
 * The messages with text content as blocks and without Anthropic's cache breakpoint, which moves to the newest message on
 * each request. Claude Code sends the same text as a string or as one text block, which the API treats alike.
 */
function unmarked(messages: Static<typeof RecordedMessages>): Static<typeof RecordedMessages> {
  return messages.map(message => ({ ...message, content: Array.isArray(message.content)
    ? message.content.map(({ cache_control: _breakpoint, ...block }) => block) : [{ type: 'text', text: message.content }] }));
}

/** The discovery settings of a host whose only runner is Claude Code, pointed at the scripted provider with a private home. */
async function claudeDiscovery(directory: string, url: string): Promise<DiscoveryConfig> {
  const home = join(directory, 'claude-home');
  await mkdir(home, { recursive: true });
  return { provider: 'claude-code', model, thinking: 'low', allowedModels: [],
    promptTemplatePath: resolve('prompts/discovery.md'), mcp: null, pi: null,
    claudeCode: { executable: null, configPaths: [join(home, '.claude'), join(home, '.claude.json')],
      environment: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'synthetic' } } };
}

async function claudeHost(t: TestContext, respond: (summary: boolean, index: number) => Reply, mcp: DiscoveryConfig['mcp'] = null) {
  const provider = await scriptedProvider(respond);
  t.after(() => provider.close());
  const discovery = { ...await claudeDiscovery(provider.directory, provider.url), mcp };
  const { runtime, client } = compose({ copyContext: copyContext(), cachePath: join(provider.directory, 'cache'), contextBudgetUnits: 1000000,
    credentialPaths: [], terminationGraceMs: 100, nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, discovery, git: null, defaultMaxOutputBytes: 10000, tools: 'core' }, null);
  t.after(() => runtime.close());
  const root = join(provider.directory, 'root'), output = join(provider.directory, 'out');
  await mkdir(root); await mkdir(output); await writeFile(join(root, 'Main.swift'), 'struct Main {}\n');
  const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] }, new AbortController().signal);
  const request = { task: 'Inspect the main type', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false,
    copyPreset: 'standard' as const, constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation' as const,
    requiredSources: [{ kind: 'full' as const, source: { root: 'r', path: 'Main.swift' } }], documents: [], patches: [], discoveryHints: [], budgetUnits: 10000 };
  let builds = 0;
  const build = (selection?: DiscoverySelection, clarification?: { questionTimeoutSeconds: number }) => {
    const name = 'packet-' + ++builds;
    const job = client.build(workspace.id, name, { ...request, outputName: name, ...clarification && { clarification } },
      clarification ? 'form' : 'unavailable', selection);
    return job.jobId;
  };
  const wait = (jobId: string) => client.wait(jobId, 60000, new AbortController().signal, () => {});
  return { provider, client, build, wait, home: discovery.claudeCode?.environment.HOME ?? '' };
}

function claudeReceipt(snapshot: JobSnapshot): ClaudeCodeDiscoveryReceipt {
  const receipt = 'discovery' in snapshot ? snapshot.discovery : null;
  assert(receipt?.adapter === 'mipmux-claude-code-v1', JSON.stringify(snapshot));
  return receipt;
}

test('Claude Code discovery sees exactly mipmux tools under the names its prompt uses, runs them and publishes a verified packet', async t => {
  const appended = '\n\n<discovered_architecture>Main is the entry point.</discovered_architecture>';
  const host = await claudeHost(t, (_summary, index) => {
    // A bare name reaches no tool; the receipt keeps it apart from the prefixed call that follows.
    if (index === 1) return { kind: 'tool', name: 'prompt', input: { op: 'get', maxOutputBytes: 8000 }, stop: 'tool_use', tokens: 10 };
    if (index === 2) return { kind: 'tool', name: 'mcp__mipmux__prompt', input: { op: 'append', text: appended, expectedRevision: 0, maxOutputBytes: 8000 }, stop: 'tool_use', tokens: 10 };
    if (index === 3) return { kind: 'tool', name: 'mcp__mipmux__draft_validate', input: { maxOutputBytes: 8000 }, stop: 'tool_use', tokens: 10 };
    return { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 };
  });
  const result = await host.wait(host.build());
  assert.equal(result.state, 'ready', JSON.stringify(result)); assert(result.state === 'ready');
  const verified = await verifyBundle(result.bundle.directory);
  assert(verified.manifest.prompt.endsWith(appended));
  const [first] = host.provider.requests; assert(first);
  assert.equal(first.model, model);
  assert.deepEqual([...first.tools].sort(), toolNames.map(name => 'mcp__mipmux__' + name).sort());
  const system = JSON.stringify(first.system);
  assert.match(system, /cc_entrypoint=mipmux;/);
  assert(system.includes('mcp__mipmux__read_file') && system.includes('mcp__mipmux__manage_selection'));
  assert.doesNotMatch(system, bareToolMention);
  const receipt = claudeReceipt(result);
  assert.equal(receipt.effective?.apiKeySource, 'ANTHROPIC_API_KEY');
  assert.deepEqual(receipt.completions.map(completion => completion.toolCalls),
    [['prompt'], ['mcp__mipmux__prompt'], ['mcp__mipmux__draft_validate'], []]);
  assert.equal(receipt.result?.subtype, 'success'); assert.equal(receipt.childClosed, true); assert(receipt.thinkingLevels?.includes('low'));
  // persistSession: false keeps Claude Code from saving the conversation.
  await assert.rejects(access(join(host.home, '.claude', 'projects')), { code: 'ENOENT' });
  await writeFile(resolve('test-output/claude-runner-proof.json'), JSON.stringify({ receipt, requests: host.provider.requests.length }, null, 2) + '\n');
});

test('external MCP tools reach Claude Code through mipmux, and only the allowlisted ones', async t => {
  const server = await controlledHttpMcp();
  t.after(() => server.close());
  let provider: Awaited<ReturnType<typeof claudeHost>>['provider'] | null = null;
  const host = await claudeHost(t, (_summary, index) => {
    if (index === 1) return { kind: 'tool', name: 'mcp__controlled__read_ticket', input: {}, stop: 'tool_use', tokens: 10 };
    if (index === 2) {
      assert(JSON.stringify(provider?.requests.at(-1)?.messages).includes('FETCHED_DOCUMENT_END'));
      return { kind: 'tool', name: 'mcp__mipmux__draft_update', input: { expectedRevision: 0, maxOutputBytes: 10000,
        mutation: { kind: 'addDocument', document: { kind: 'suppliedDocument', id: 'fetched-ticket', role: 'evidence', origin: server.url, text: server.text } } },
      stop: 'tool_use', tokens: 10 };
    }
    return { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 };
  }, await mcpDirectory(server.url));
  provider = host.provider;
  const result = await host.wait(host.build());
  assert.equal(result.state, 'ready', JSON.stringify(result)); assert(result.state === 'ready');
  const document = (await verifyBundle(result.bundle.directory)).manifest.materials.find(material => material.id === 'document:fetched-ticket');
  assert(document?.kind === 'document');
  assert.deepEqual(document.input, { kind: 'suppliedDocument', id: 'fetched-ticket', role: 'evidence', origin: server.url, text: server.text });
  assert.deepEqual(server.calls, ['read_ticket']);
  for (const request of host.provider.requests) {
    assert(request.tools.includes('mcp__controlled__read_ticket')); assert(!request.tools.includes('mcp__controlled__delete_ticket'));
  }
  const receipt = claudeReceipt(result);
  assert.equal(receipt.mcp?.readiness.state, 'ready'); assert.equal(receipt.mcp?.shutdown, 'dispatched');
  assert(!JSON.stringify({ result, requests: host.provider.requests }).includes('synthetic$!mcp-token'));
});

async function mcpDirectory(url: string) {
  const agentDirectory = join(resolve('test-output'), 'claude-mcp-' + process.pid + '-' + Date.now());
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(agentDirectory, 'mcp.json'), JSON.stringify({ mcpServers: { controlled: {
    url, exposure: 'hidden', toolExposure: { read_ticket: 'direct' }, headers: { Authorization: 'Bearer synthetic$$$!mcp-token' } } } }));
  return { agentDirectory };
}

test('an unsupported level or an unavailable external server stops before any model request', async t => {
  const server = await controlledHttpMcp();
  t.after(() => server.close());
  const unsent: Reply = { kind: 'text', text: 'unexpected', stop: 'end_turn', tokens: 10 };
  const host = await claudeHost(t, () => unsent);
  const minimal = await host.wait(host.build({ thinking: 'minimal' }));
  assert(minimal.state === 'failed'); assert.equal(minimal.code, 'unsupportedThinkingLevel');
  assert.deepEqual(claudeReceipt(minimal).thinkingLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  const external = await claudeHost(t, () => unsent, await mcpDirectory(server.url));
  for (const state of ['missing', 'unauthorized'] as const) {
    server.state[state] = true;
    const refused = await external.wait(external.build());
    assert(refused.state === 'failed'); assert.equal(refused.code, 'mcpToolsUnavailable');
    server.state[state] = false;
  }
  assert.equal(host.provider.requests.length + external.provider.requests.length, 0);
});

test('cancelling during a model request stops Claude Code without another request', async t => {
  let entered!: () => void;
  const holding = new Promise<void>(resolve => { entered = resolve; });
  const host = await claudeHost(t, () => ({ kind: 'hold', entered }));
  const jobId = host.build();
  await holding;
  host.client.cancel(jobId);
  const result = await host.wait(jobId);
  assert.equal(result.state, 'cancelled');
  assert.equal(claudeReceipt(result).childClosed, true);
  assert.equal(host.provider.requests.length, 1);
});

test('a response that reports another model than the one Claude Code serves stops discovery before another request', async t => {
  const host = await claudeHost(t, (_summary, index) => index === 1
    ? { kind: 'tool', name: 'mcp__mipmux__draft_validate', input: { maxOutputBytes: 8000 }, stop: 'tool_use', tokens: 10, reportedModel: 'another-model' }
    : { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 });
  const result = await host.wait(host.build());
  assert.equal(result.state, 'failed', JSON.stringify(result)); assert(result.state === 'failed');
  assert.equal(result.code, 'modelIdentityMismatch');
  const receipt = claudeReceipt(result);
  assert.equal(receipt.childClosed, true);
  assert.deepEqual(receipt.completions.map(completion => completion.reported.model), ['another-model']);
  assert.equal(host.provider.requests.length, 1);
});

test('a clarification question waits inside the Claude Code conversation, which continues with the answer', async t => {
  const host = await claudeHost(t, (_summary, index) => index === 1
    ? { kind: 'tool', name: 'mcp__mipmux__ask_user', input: { questions: [{ id: 'focus', question: 'Which area?', options: ['API', 'UI'] }] }, stop: 'tool_use', tokens: 10 }
    : { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 });
  const jobId = host.build(undefined, { questionTimeoutSeconds: 60 });
  await host.wait(jobId);
  const question = host.client.pendingQuestion(jobId); assert(question);
  host.client.answerQuestion(jobId, question.id, { action: 'accept', content: { focus: 'API' } });
  const result = await host.wait(jobId);
  assert.equal(result.state, 'ready', JSON.stringify(result));
  const [first, second] = host.provider.requests.map(request => unmarked(recorded(request.messages)));
  assert(first && second);
  assert(host.provider.requests[0]?.tools.includes('mcp__mipmux__ask_user'));
  assert.deepEqual(second.slice(0, first.length), first, 'the answer continues the same conversation');
  // The answer arrives as the result of the ask_user call the model made in the first request.
  assert(JSON.stringify(second.slice(first.length)).includes('\\"answers\\":[\\"API\\"]'));
});

test('mipmux models lists the Claude Code models of a Claude-only configuration without a model request', async () => {
  const provider = await scriptedProvider(() => ({ kind: 'text', text: 'unexpected', stop: 'end_turn', tokens: 10 }));
  try {
    const discovery = await claudeDiscovery(provider.directory, provider.url);
    const configPath = join(provider.directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ cachePath: join(provider.directory, 'cache'), discovery: { provider: discovery.provider,
      model: discovery.model, thinking: discovery.thinking, claudeCode: { environment: discovery.claudeCode?.environment } } }));
    const { stdout } = await promisify(execFile)(process.execPath, [resolve('dist/cli/main.js'), 'models', '--config', configPath]);
    const listed = Compile(Type.Object({ kind: Type.Literal('models'), models: Type.Array(Type.String()) })).Parse(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''));
    assert(listed.models.includes('claude-code/' + model), stdout);
    assert(listed.models.every(reference => reference.startsWith('claude-code/')));
    assert.equal(provider.requests.length, 0);
    assert.equal((await readFile(configPath, 'utf8')).includes('modelsPath'), false);
  } finally { await provider.close(); }
});
