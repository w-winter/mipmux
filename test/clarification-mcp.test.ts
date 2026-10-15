import assert from 'node:assert/strict';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { contextRequestValidator } from '../src/contracts/context.js';
import { AskUserResponse } from '../src/contracts/interaction.js';
import { verifyBundle } from '../src/index.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';

function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const workspaceReply = Compile(Type.Object({ id: Type.String() }));
const jobReply = Compile(Type.Object({ jobId: Type.String(), state: Type.String(), localSettled: Type.Boolean() }));
const readyReply = Compile(Type.Object({ state: Type.Literal('ready'), localSettled: Type.Literal(true),
  bundle: Type.Object({ directory: Type.String() }) }));
const errorReply = Compile(Type.Object({ code: Type.String() }));
const sourceAnswer = Compile(AskUserResponse);
const toolMessage = Compile(Type.Object({ role: Type.Literal('user'), content: Type.Array(Type.Object({
  type: Type.Literal('tool_result'), content: Type.String(), is_error: Type.Boolean(),
})) }));
const processEvent = Compile(Type.Object({ event: Type.Enum(['processSpawned', 'processClosed']), id: Type.String() }));
const formReply = Compile(Type.Object({ resultType: Type.Literal('input_required'), inputRequests: Type.Record(Type.String(),
  Type.Object({ params: Type.Object({ requestedSchema: Type.Object({ properties: Type.Record(Type.String(), Type.Object({ type: Type.String() })) }) }) })) }));

const scenarios = ['accept', 'empty-answer', 'decline', 'form-cancel', 'timeout', 'job-cancel', 'close', 'unavailable', 'disabled', 'foreign-answer'] as const;
type Scenario = typeof scenarios[number];

async function createFixture(scenario: Scenario, t: TestContext) {
  const questionEntered = barrier(), resumed = barrier(), releaseAnswer = barrier();
  const provider = await scriptedProvider((_summary, index) => {
    if (scenario === 'disabled') return { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 };
    if (index === 1 || scenario === 'foreign-answer' && index === 2) return { kind: 'tool', name: 'ask_user', input: { title: 'Scope question',
      questions: [{ id: 'focus', question: 'Which area?', options: ['API', 'UI'],
        allows_multiple: scenario === 'accept', allows_custom: scenario === 'accept' }] }, stop: 'tool_use', tokens: 10 };
    resumed.release();
    if (scenario === 'accept' && index === 2) return { kind: 'tool', name: 'ask_user', input: {
      questions: [{ id: 'approval', question: 'Confirm the selected context?', options: ['Yes', 'Revise'], allows_custom: false }] },
      stop: 'tool_use', tokens: 10 };
    return { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 };
  });
  t.after(() => provider.close());
  const root = join(provider.directory, 'root'), outputRoot = join(provider.directory, 'out');
  await mkdir(root); await mkdir(outputRoot); await writeFile(join(root, 'Main.swift'), 'struct Main {}\n');
  const configPath = join(provider.directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ cachePath: join(provider.directory, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 200000, credentialPaths: [], git: null,
    discovery: { ...provider.config, prompt: { kind: 'rpce' } }, defaultMaxOutputBytes: 12000 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', configPath], cwd: '/', stderr: 'pipe' });
  const diagnostics: Buffer[] = []; transport.stderr?.on('data', bytes => diagnostics.push(Buffer.from(bytes)));
  const client = new Client({ name: 'clarification-fixture', version: '1' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } }, capabilities: scenario === 'unavailable' ? {} : { elicitation: { form: {} } },
    inputRequired: { autoFulfill: scenario !== 'foreign-answer' },
  });
  t.after(() => client.close());
  let questions = 0;
  if (scenario !== 'unavailable') client.setRequestHandler('elicitation/create', async request => {
    questions++; questionEntered.release();
    if (scenario === 'timeout' || scenario === 'job-cancel' || scenario === 'close') await releaseAnswer.promise;
    if (scenario === 'decline') return { action: 'decline' };
    if (scenario === 'form-cancel') return { action: 'cancel' };
    if (scenario === 'empty-answer') return { action: 'accept', content: {} };
    assert.equal(request.params.mode, 'form');
    const fields = request.params.requestedSchema.properties;
    return { action: 'accept', content: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key,
      field.type === 'array' ? ['API'] : questions > 1 ? 'Yes' : scenario === 'accept' ? 'also docs' : 'API'])) };
  });
  await client.connect(transport);
  const workspace = workspaceReply.Parse((await client.callTool({ name: 'workspace_declare', arguments: {
    spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot },
  } })).structuredContent);
  const request = contextRequestValidator.Parse({ task: 'Inspect the selected context', constraints: '', enhancementMode: 'augment',
    purpose: 'investigation', initialSelection: { codemapMode: 'manual', sources: [] },
    requiredSources: [{ kind: 'full', source: { root: 'r', path: 'Main.swift' } }], documents: [], patches: [],
    storedPrompts: [], copyPreset: 'standard', duplicateUserInstructionsAtTop: false, discoveryHints: [],
    budgetUnits: 10000, outputName: 'packet' });
  if (scenario !== 'disabled') request.clarification = { questionTimeoutSeconds: scenario === 'timeout' ? 1 : 300 };
  return { scenario, provider, client, transport, diagnostics, request, workspace, outputRoot,
    questionEntered, resumed, releaseAnswer, get questions() { return questions; } };
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;
type Waiting = ReturnType<Client['callTool']>;

async function checkForeignAnswer(f: Fixture, firstJobId: string) {
  const { client, workspace, request } = f;
  const form = formReply.Parse(await client.callTool({ name: 'context_builder_wait', arguments: { jobId: firstJobId, durationMs: 10000 } },
    { allowInputRequired: true }));
  const second = jobReply.Parse((await client.callTool({ name: 'context_builder', arguments: {
    workspaceId: workspace.id, requestId: 'second', request: { ...request, outputName: 'second' },
  } })).structuredContent);
  const secondForm = formReply.Parse(await client.callTool({ name: 'context_builder_wait', arguments: { jobId: second.jobId, durationMs: 10000 } },
    { allowInputRequired: true }));
  const firstId = Object.keys(form.inputRequests)[0]!, secondId = Object.keys(secondForm.inputRequests)[0]!;
  const answer = { action: 'accept', content: Object.fromEntries(Object.keys(
    form.inputRequests[firstId]!.params.requestedSchema.properties).map(key => [key, 'API'])) };
  const rejected = await client.request({ method: 'tools/call', params: { name: 'context_builder_wait',
    arguments: { jobId: second.jobId, durationMs: 10000 }, inputResponses: { [firstId]: answer } } });
  assert.equal(rejected.isError, true); assert.equal(errorReply.Parse(rejected.structuredContent).code, 'interactionNotCurrent');
  const results: ReturnType<typeof readyReply.Parse>[] = [];
  const pendingAnswers: [string, string][] = [[firstJobId, firstId], [second.jobId, secondId]];
  for (const [jobId, questionId] of pendingAnswers) results.push(readyReply.Parse((await client.request({
    method: 'tools/call', params: { name: 'context_builder_wait', arguments: { jobId, durationMs: 10000 },
      inputResponses: { [questionId]: answer } },
  })).structuredContent));
  await writeFile('test-output/clarification-foreign-answer-proof.json', JSON.stringify({ rejected, results }, null, 2) + '\n');
}

function assertProcessesClosed(diagnostics: readonly Buffer[]) {
  const spawned = new Set<string>(), closed = new Set<string>();
  for (const line of Buffer.concat(diagnostics).toString().split('\n')) {
    if (!line.startsWith('{')) continue;
    const event: unknown = JSON.parse(line);
    if (processEvent.Check(event)) (event.event === 'processSpawned' ? spawned : closed).add(event.id);
  }
  assert(spawned.size > 0); assert.deepEqual(closed, spawned);
}

async function checkCancellation(f: Fixture, jobId: string, waiting: Waiting) {
  await f.questionEntered.promise;
  if (f.scenario === 'job-cancel') await f.client.callTool({ name: 'context_builder_cancel', arguments: { jobId } });
  else await f.transport.close();
  f.releaseAnswer.release();
  await waiting.catch(() => {});
  if (f.scenario === 'job-cancel') {
    const result = jobReply.Parse((await f.client.callTool({ name: 'context_builder_wait', arguments: { jobId, durationMs: 10000 } })).structuredContent);
    assert.equal(result.state, 'cancelled'); assert.equal(result.localSettled, true);
  }
  await assert.rejects(access(join(f.outputRoot, 'packet', 'manifest.json')));
  assert.equal(f.provider.requests.length, 1);
  if (f.scenario === 'close') assertProcessesClosed(f.diagnostics);
}

function assertSourceResponse(f: Fixture) {
  const response = toolMessage.Parse(f.provider.requests[1]!.messages.at(-1)).content[0]!;
  if (f.scenario === 'form-cancel') {
    assert.equal(response.is_error, true); assert.equal(errorReply.Parse(JSON.parse(response.content)).code, 'cancelled');
    return;
  }
  assert.equal(response.is_error, false);
  const answer = sourceAnswer.Parse(JSON.parse(response.content));
  assert.equal(answer.timed_out, f.scenario === 'timeout'); assert.equal(answer.skipped, f.scenario === 'decline');
  assert.deepEqual(answer.answers.focus, f.scenario === 'accept'
    ? { answers: ['API', 'also docs'], selected_options: ['API'], custom_response: 'also docs', skipped: false }
    : { answers: [], selected_options: [], custom_response: null, skipped: f.scenario === 'decline' || f.scenario === 'empty-answer' });
}

async function checkCompletion(f: Fixture, jobId: string, waiting: Waiting) {
  const { scenario, client, provider, request } = f;
  const first = await waiting;
  if (scenario === 'timeout') {
    assert.equal(first.isError, true);
    assert.equal(errorReply.Parse(first.structuredContent).code, 'interactionNotCurrent');
  } else assert.equal(first.isError, false, JSON.stringify(first));
  const result = readyReply.Parse((scenario === 'timeout' ? await client.callTool({ name: 'context_builder_wait',
    arguments: { jobId, durationMs: 10000 } }) : first).structuredContent);
  const packet = await verifyBundle(result.bundle.directory);
  assert.equal(packet.manifest.prompt, request.task);
  assert.equal(f.questions, scenario === 'accept' ? 2 : scenario === 'disabled' ? 0 : 1);
  const policy = JSON.stringify(provider.requests[0]!.system);
  assert.equal(provider.requests[0]!.tools.includes('ask_user'), scenario !== 'disabled');
  if (scenario !== 'disabled') assert(policy.includes('confirm the selection before halting'));
  if (scenario !== 'disabled') assertSourceResponse(f);
}

for (const scenario of scenarios) {
  test(`real scout clarification through MCP owns the interaction: ${scenario}`, async t => {
    const f = await createFixture(scenario, t);
    try {
      const started = await f.client.callTool({ name: 'context_builder', arguments: {
        workspaceId: f.workspace.id, requestId: scenario, request: f.request,
      } });
      if (scenario === 'unavailable') {
        assert.equal(started.isError, true);
        assert.equal(errorReply.Parse(started.structuredContent).code, 'elicitationUnavailable');
        assert.equal(f.provider.requests.length, 0);
      } else {
        const job = jobReply.Parse(started.structuredContent);
        if (scenario === 'foreign-answer') await checkForeignAnswer(f, job.jobId);
        else {
          const waiting = f.client.callTool({ name: 'context_builder_wait', arguments: { jobId: job.jobId, durationMs: 10000 } });
          void waiting.catch(() => {});
          if (scenario === 'timeout') { await f.resumed.promise; f.releaseAnswer.release(); }
          if (scenario === 'job-cancel' || scenario === 'close') await checkCancellation(f, job.jobId, waiting);
          else await checkCompletion(f, job.jobId, waiting);
        }
      }
      await writeFile(join(f.provider.directory, 'clarification-proof.json'), JSON.stringify({ scenario, questions: f.questions,
        requests: f.provider.requests, diagnostics: Buffer.concat(f.diagnostics).toString() }, null, 2) + '\n');
      await mkdir('test-output', { recursive: true });
      await writeFile('test-output/clarification-' + scenario + '-proof.json', JSON.stringify({ scenario, directory: f.provider.directory, questions: f.questions }) + '\n');
    } finally {
      f.releaseAnswer.release(); await f.client.close();
    }
  });
}
