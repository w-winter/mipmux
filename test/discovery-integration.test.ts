import { nativeDiscoveryRenderer } from './fixtures/render-discovery-prompt.js';
import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { prepareText } from '../src/exploration/lines.js';
import { MipmuxRuntime, verifyBundle, type ContextBuildRequest } from '../src/index.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import type { ProcessSpec } from '../src/runtime/process-supervisor.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { DiscoveryInput } from '../src/discovery/runner.js';

test('scripted real SDK builder publishes and verifies complete source/report/task and retains a receipt', async () => {
  let ordinary = 0;
  const provider = await scriptedProvider(summary => {
    assert.equal(summary, false);
    ordinary++;
    if (ordinary === 1) return { kind: 'tool', name: 'manage_selection', input: { op: 'preview', expectedRevision: 0,
      maxOutputBytes: 20000, paths: ['r/oversize.txt'] }, stop: 'tool_use', tokens: 10 };
    if (ordinary === 2) return { kind: 'tool', name: 'draft_inspect', input: { view: 'material', materialId: 'document:report', maxOutputBytes: 2000, continuation: null }, stop: 'tool_use', tokens: 10 };
    if (ordinary === 3) return { kind: 'tool', name: 'draft_update', input: { expectedRevision: 0, maxOutputBytes: 10000,
      mutation: { kind: 'upsert', selection: { kind: 'full', source: { root: 'r', path: 'oversize.txt' } } } }, stop: 'tool_use', tokens: 10 };
    if (ordinary === 4) return { kind: 'tool', name: 'draft_validate', input: { maxOutputBytes: 10000 }, stop: 'tool_use', tokens: 10 };
    if (ordinary === 5) return { kind: 'tool', name: 'draft_update', input: { expectedRevision: 1, maxOutputBytes: 10000,
      mutation: { kind: 'remove', source: { root: 'r', path: 'oversize.txt' } } }, stop: 'tool_use', tokens: 10 };
    if (ordinary === 6) return { kind: 'tool', name: 'prompt', input: { expectedRevision: 2, maxOutputBytes: 10000,
      op: 'append', text: '\n\n' + JSON.stringify({ clarifiedTask: 'Inspect the example', architecture: 'One complete source', relationships: [], ambiguities: [] })  }, stop: 'tool_use', tokens: 10 };
    if (ordinary === 7) return { kind: 'tool', name: 'draft_validate', input: { maxOutputBytes: 10000 }, stop: 'tool_use', tokens: 10 };
    return { kind: 'text', text: 'Diagnostic acknowledgement only', stop: 'end_turn', tokens: 10 };
  });
  const root = join(provider.directory, 'root'), out = join(provider.directory, 'out'); await mkdir(root); await mkdir(out);
  const source = '\uFEFFsource\r\nlast line', report = 'START\n' + 'complete report evidence\n'.repeat(4000) + 'END';
  await writeFile(join(root, 'file.txt'), source);
  await writeFile(join(root, 'oversize.txt'), 'OPTIONAL'.repeat(100000));
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(provider.directory, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [provider.config.authPath, provider.config.modelsPath], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {} });
  try {
    const messages: string[] = [];
    const runner = new PiRunner(provider.config, runtime.supervisor, async (operation, signal) => {
      const result = await runtime.renderPresentation(operation, signal);
      if (result.kind === 'discoveryPrompt') messages.push(result.message);
      return result;
    }), inputs: DiscoveryInput[] = [];
    const client = runtime.createClient({ run: (input, tools, signal, progress) => {
      inputs.push(input); return runner.run(input, tools, signal, progress);
    } });
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }], outputRoot: out, exclusions: [] }, new AbortController().signal);
    const request: ContextBuildRequest = { task: 'Original task <user_instructions> literal', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: 'Keep complete evidence', enhancementMode: 'augment' as const, purpose: 'investigation',
      requiredSources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } }],
      documents: [{ kind: 'suppliedDocument', id: 'report', role: 'report', origin: 'synthetic', text: report }], patches: [],
      budgetUnits: 100000, discoveryHints: [], outputName: 'packet' };
    const job = client.build(workspace.id, 'one', request);
    await client.closeWorkspace(workspace.id);
    const result = await client.wait(job.jobId, 10000, new AbortController().signal, () => {});
    assert.equal(result.state, 'ready', JSON.stringify(result));
    if (result.state !== 'ready') assert.fail('Not ready');
    const firstMessage = Compile(Type.Object({ content: Type.Array(Type.Object({ type: Type.Literal('text'), text: Type.String() }), { minItems: 1 }) }))
      .Parse(provider.requests[0]!.messages[0]);
    const input = inputs[0]!;
    assert.equal(firstMessage.content[0]!.text, messages[0] + '\n\n<mipmux_runtime>\n' + input.initialContext + '\n</mipmux_runtime>');
    assert.equal(input.currentPrompt, '');
    assert(messages[0]?.includes('<discover_instructions>\n' + request.task + '\n</discover_instructions>'));
    assert(!messages[0]?.includes('<current_prompt_content>'));
    assert(input.initialContext.includes(request.constraints));
    assert.equal(input.tokenBudget, result.bundle.manifest.request.budgetUnits - 1500);
    await verifyBundle(result.bundle.directory);
    const packet = await readFile(join(result.bundle.directory, 'context.md'), 'utf8');
    for (const text of [source.slice(1), report, request.constraints, '"clarifiedTask":"Inspect the example"']) assert(packet.includes(text));
    assert(!packet.includes('OPTIONAL'));
    assert(provider.requests.some(request => JSON.stringify(request.messages).includes('overBudget')));
    assert(!packet.includes('Diagnostic acknowledgement only'));
    assert.equal(result.discovery.workerClosed, true); assert.equal(result.discovery.parentToolsSettled, true);
    assert.equal(result.discovery.acceptedRuns, 1);
    assert.equal(result.discovery.effective?.modelRecord.contextWindow, 8192);
    assert.equal(result.discovery.effective?.modelRecord.baseUrl, undefined);
    await writeFile(join(provider.directory, 'terminal-receipt.json'), JSON.stringify(result, null, 2));
    ordinary = 0;
    const configPath = join(provider.directory, 'cli-config.json'), requestPath = join(provider.directory, 'cli-request.json');
    await writeFile(configPath, JSON.stringify({ ...runtime.options, git: null,
      defaultMaxOutputBytes: 10000, discovery: provider.config }));
    await writeFile(requestPath, JSON.stringify({ workspace: { roots: [{ name: 'r', absolutePath: root }], outputRoot: out, exclusions: [] },
      requestId: 'cli', request: { ...request, outputName: 'cli-packet' } }));
    const cliResult = await promisify(execFile)(process.execPath, [resolve('dist/cli/main.js'), 'build', '--request', requestPath,
      '--config', configPath], { cwd: '/', maxBuffer: 10 * 1024 * 1024 });
    const cliReceipt = JSON.parse(cliResult.stdout);
    assert.equal(cliReceipt.state, 'ready'); await verifyBundle(cliReceipt.bundle.directory);
    await writeFile(join(provider.directory, 'cli-terminal-receipt.json'), cliResult.stdout);
  } finally { await runtime.close(); await provider.close(); }
});

test('cancellation during blocked SDK preflight joins forced closure before any model request', async () => {
  const provider = await scriptedProvider(() => { throw new Error('No model call permitted'); });
  const fifo = join(provider.directory, 'preflight-fifo');
  await promisify(execFile)('mkfifo', [fifo]);
  provider.config.authPath = fifo;
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 0 }), abort = new AbortController();
  const work = new PiRunner(provider.config, supervisor, nativeDiscoveryRenderer(supervisor)).run({ tokenBudget: 10000, enhancementMode: 'fullRewrite' as const, task: 'Task', purpose: 'investigation', initialContext: 'Fixture context', fileTree: '', currentPrompt: 'Fixture message', restrictsReviewGitToExplicitReadOnly: true, constraints: '', roots: [], hints: [] },
    { call: async () => { throw new Error('No tool permitted'); } }, abort.signal, () => {});
  // Opening the writer proves that the child is blocked in the matching read, without a timing delay.
  const writer = await open(fifo, 'w');
  try {
    abort.abort();
    const result = await work;
    assert.equal(result.kind, 'cancelled'); assert.equal(result.receipt.acceptedRuns, 0);
    assert.equal(result.receipt.workerClosed, true); assert.equal(provider.requests.length, 0);
  } finally { await writer.close(); await supervisor.close(); await provider.close(); }
});

test('discovery material paging measures the real Pi result and returns every complete line without an MCP copy', async () => {
  const text = '"\\🙂'.repeat(80) + '\n' + 'second'.repeat(80) + '\n';
  const lines = prepareText(text).lines;
  const firstPage = { kind: 'material', materialId: 'document:report', digest: '0'.repeat(64), lines: lines.slice(0, 1),
    truncated: true, continuation: { digest: '0'.repeat(64), offset: 1 } };
  const cap = Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(firstPage) }], isError: false }));
  let calls = 0;
  const provider = await scriptedProvider(() => ++calls <= 2
    ? { kind: 'tool', name: 'draft_inspect', input: { view: 'material', materialId: 'document:report', maxOutputBytes: cap,
      continuation: calls === 1 ? null : continuation }, stop: 'tool_use', tokens: 10 }
    : { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 });
  let continuation: { digest: string; offset: number } | null = null;
  const root = join(provider.directory, 'source'), output = join(provider.directory, 'out'); await mkdir(root); await mkdir(output);
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(provider.directory, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {} });
  try {
    const client = runtime.createClient(new PiRunner(provider.config, runtime.supervisor, (operation, signal) => runtime.renderPresentation(operation, signal)));
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] }, new AbortController().signal);
    const originalCall = client.inspect.bind(client);
    const draft = await client.createDraft(workspace.id, { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation', requiredSources: [],
      documents: [{ kind: 'suppliedDocument', id: 'report', role: 'report', origin: 'fixture', text }], patches: [], discoveryHints: [],
      outputName: 'packet', budgetUnits: 10000 }, new AbortController().signal);
    const runner = new PiRunner(provider.config, runtime.supervisor, (operation, signal) => runtime.renderPresentation(operation, signal));
    const returned: string[] = [];
    const result = await runner.run({ tokenBudget: 10000, enhancementMode: 'fullRewrite' as const, task: 'Inspect', purpose: 'investigation', initialContext: 'Fixture context', fileTree: '', currentPrompt: 'Fixture message', restrictsReviewGitToExplicitReadOnly: true, constraints: '', hints: [], roots: ['r'] }, {
      call: async (call, _signal, encode) => {
        assert(call.name === 'draft_inspect');
        const page = await originalCall(draft.id, call.input, _signal, encode);
        assert(page.kind === 'material');
        continuation = page.continuation;
        returned.push(...page.lines.map(line => line.text));
        const actual = { content: [{ type: 'text', text: JSON.stringify(page) }], isError: false };
        assert(Buffer.byteLength(JSON.stringify(actual)) <= cap);
        return page;
      },
    }, new AbortController().signal, () => {});
    assert.equal(result.kind, 'complete'); assert.equal(returned.join(''), text); assert.equal(continuation, null);
    calls = 1;
    const job = client.build(workspace.id, 'paging', { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation', requiredSources: [],
      documents: [{ kind: 'suppliedDocument', id: 'report', role: 'report', origin: 'fixture', text }], patches: [], discoveryHints: [],
      outputName: 'builder', budgetUnits: 10000 });
    const built = await client.wait(job.jobId, 10000, new AbortController().signal, () => {});
    assert.equal(built.state, 'ready');
    const messages = JSON.stringify(provider.requests.at(-1)!.messages);
    assert(messages.includes('\\"kind\\":\\"material\\"'), messages);
    assert(messages.includes('\\"truncated\\":true'), messages);
    assert(!messages.includes('recordTooLarge'), messages);
    await writeFile(join(provider.directory, 'paging-receipt.json'), JSON.stringify({ cap, result, returned }) + '\n');
  } finally { await runtime.close(); await provider.close(); }
});

test('forced worker closure preserves observed preflight and waits for parent-owned tool settlement', async () => {
  let entered!: () => void, release!: () => void, closed!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const closure = new Promise<void>(resolve => { closed = resolve; });
  const provider = await scriptedProvider(() => ({ kind: 'tool', name: 'draft_inspect',
    input: { view: 'metadata', maxOutputBytes: 10000, continuation: null }, stop: 'tool_use', tokens: 10 }));
  class Supervisor extends ProcessSupervisor {
    override spawn(spec: ProcessSpec) { const process = super.spawn(spec); void process.closed.then(closed); return process; }
  }
  const supervisor = new Supervisor({ terminationGraceMs: 0 }), abort = new AbortController();
  try {
    let finished = false;
    const work = new PiRunner(provider.config, supervisor, nativeDiscoveryRenderer(supervisor)).run({ tokenBudget: 10000, enhancementMode: 'fullRewrite' as const, task: 'Task', purpose: 'investigation', initialContext: 'Fixture context', fileTree: '', currentPrompt: 'Fixture message', restrictsReviewGitToExplicitReadOnly: true, constraints: '', hints: [], roots: [] },
      { call: async () => { entered(); await released; return { kind: 'metadata' }; } }, abort.signal, () => {});
    void work.then(() => { finished = true; });
    await entering; abort.abort(); await closure;
    assert.equal(finished, false);
    release();
    const result = await work;
    assert.equal(result.kind, 'cancelled');
    assert.equal(result.receipt.parentToolsSettled, true);
    assert.equal(result.receipt.effective?.identity.model, provider.config.model);
    assert(result.receipt.completions.length > 0);
    assert.equal(result.receipt.finalAssistant?.stopReason, 'toolUse');
    assert.equal(result.receipt.finalAssistant?.channel, 'ordinary');
    assert.equal(result.receipt.disposed, false);
  } finally { release(); await supervisor.close(); await provider.close(); }
});

test('summary retry uses the same SDK stream observer, while incomplete output and preflight failures cannot complete', async () => {
  for (const scenario of ['summary', 'length', 'empty', 'error', 'preflight', 'cancel', 'wrongIdentity', 'thresholdFailed',
    'lengthRecovered', 'overflowExhausted', 'compactionCancel', 'truncatedTool', 'commandAuth', 'clamping'] as const) {
    let ordinary = 0, summaries = 0, toolCalls = 0, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const provider = await scriptedProvider(summary => {
      if (scenario === 'cancel') return { kind: 'hold', entered };
      if (summary) {
        summaries++;
        if (scenario === 'compactionCancel') return { kind: 'hold', entered };
        return summaries === 1 || scenario === 'thresholdFailed' ? { kind: 'error' } : { kind: 'text', text: 'Summary of synthetic data', stop: 'end_turn', tokens: 10 };
      }
      ordinary++;
      if (scenario === 'error') return { kind: 'error' };
      if (scenario === 'overflowExhausted') return { kind: 'overflow' };
      if (['summary', 'thresholdFailed', 'compactionCancel', 'truncatedTool'].includes(scenario) && ordinary === 1) return { kind: 'tool', name: 'draft_inspect',
        input: { view: 'metadata', maxOutputBytes: 10000, continuation: null }, stop: scenario === 'truncatedTool' ? 'max_tokens' : 'tool_use', tokens: 10000 };
      return { kind: 'text', text: scenario === 'empty' ? '' : 'Complete', stop: scenario === 'length' || scenario === 'lengthRecovered' && ordinary === 1 ? 'max_tokens' : 'end_turn', tokens: 10,
        ...(scenario === 'wrongIdentity' ? { reportedModel: 'another-model' } : {}) };
    });
    if (!['summary', 'thresholdFailed', 'lengthRecovered', 'overflowExhausted', 'compactionCancel'].includes(scenario)) provider.config.policy.compaction.enabled = false;
    if (scenario === 'preflight') provider.config.model = 'absent-model';
    if (scenario === 'commandAuth') await writeFile(provider.config.authPath, JSON.stringify({ anthropic: { type: 'api_key', key: '!echo forbidden' } }));
    if (scenario === 'clamping') provider.config.thinking = 'max';
    const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 }), abort = new AbortController();
    try {
      const work = new PiRunner(provider.config, supervisor, nativeDiscoveryRenderer(supervisor)).run({ tokenBudget: 10000, enhancementMode: 'fullRewrite' as const, task: 'Task '.repeat(1000), purpose: 'investigation', initialContext: 'Fixture context', fileTree: '', currentPrompt: 'Fixture message', restrictsReviewGitToExplicitReadOnly: true, constraints: '', hints: [], roots: ['r'] },
        { call: async () => { toolCalls++; return { kind: 'metadata', body: 'data '.repeat(1000) }; } }, abort.signal, () => {});
      if (scenario === 'cancel' || scenario === 'compactionCancel') { await started; abort.abort(); }
      const result = await work;
      const expected = ['summary', 'thresholdFailed', 'lengthRecovered', 'truncatedTool'].includes(scenario) ? 'complete'
        : scenario === 'cancel' || scenario === 'compactionCancel' ? 'cancelled' : 'failed';
      assert.equal(result.kind, expected, scenario + JSON.stringify(result));
      if (scenario === 'truncatedTool') assert.equal(toolCalls, 0);
      assert.equal(result.receipt.workerClosed, true);
      if (scenario === 'summary') {
        assert(summaries >= 2);
        assert(result.receipt.completions.some(completion => completion.channel === 'summary' && completion.stopReason === 'error'));
        assert(result.receipt.events.some(event => event.kind === 'summarization_retry_scheduled'));
      }
      if (['preflight', 'commandAuth', 'clamping'].includes(scenario)) { assert.equal(result.receipt.acceptedRuns, 0); assert.equal(provider.requests.length, 0); }
      await writeFile(join(provider.directory, 'receipt.json'), JSON.stringify(result, null, 2));
    } finally { await supervisor.close(); await provider.close(); }
  }
});

test('normally completed budget-blocked SDK builder retains every committed handoff field for its caller', async () => {
  const handoff = { clarifiedTask: 'Full clarification', architecture: 'Full architecture'.repeat(200),
    relationships: ['one uses two', 'three owns four'], ambiguities: ['first ambiguity', 'second ambiguity'] };
  let calls = 0;
  const provider = await scriptedProvider(() => ++calls === 1 ? { kind: 'tool', name: 'prompt', input: {
    expectedRevision: 0, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify(handoff)  }, stop: 'tool_use', tokens: 10 }
    : { kind: 'text', text: 'Completed handoff', stop: 'end_turn', tokens: 10 });
  const root = join(provider.directory, 'root'), output = join(provider.directory, 'out'); await mkdir(root); await mkdir(output);
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(provider.directory, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {} });
  try {
    const client = runtime.createClient(new PiRunner(provider.config, runtime.supervisor, (operation, signal) => runtime.renderPresentation(operation, signal))), other = runtime.createClient(null);
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] }, new AbortController().signal);
    const job = client.build(workspace.id, 'handoff', { task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', enhancementMode: 'augment' as const, purpose: 'planning', requiredSources: [], documents: [], patches: [],
      discoveryHints: [], outputName: 'blocked', budgetUnits: 1 });
    const result = await client.wait(job.jobId, 10000, new AbortController().signal, () => {}); assert(result.state === 'blocked');
    const small = (await client.inspect(result.draftId, { view: 'metadata', continuation: null, maxOutputBytes: 2000 }, new AbortController().signal));
    assert.equal(small.kind, 'recordTooLarge');
    const recovered = (await client.inspect(result.draftId, { view: 'metadata', continuation: null, maxOutputBytes: 20000 }, new AbortController().signal));
    assert(recovered.kind === 'metadata'); assert.equal(recovered.revision, 1);
    assert.deepEqual(recovered.items, [{ kind: 'prompt', prompt: '\n\n' + JSON.stringify(handoff) }]);
    await assert.rejects(async () => (await other.inspect(result.draftId, { view: 'metadata', continuation: null, maxOutputBytes: 20000 }, new AbortController().signal)), /unknownDraft/);
    assert.equal(calls, 2); assert.equal(result.discovery.acceptedRuns, 1);
    await writeFile(join(provider.directory, 'blocked-handoff-proof.json'), JSON.stringify({ result, small, recovered, calls }) + '\n');
    await client.close(); await other.close();
  } finally { await runtime.close(); await provider.close(); }
});

test('discovery scripts reach mipmux tools through codemode', async () => {
  const script = 'const reply = await tools.draft_inspect({ view: "metadata", maxOutputBytes: 10000, continuation: null }); return reply;';
  const provider = await scriptedProvider((_summary, index) => index === 1
    ? { kind: 'tool', name: 'codemode', input: { code: script }, stop: 'tool_use', tokens: 10 }
    : { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 });
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 0 }), calls: string[] = [];
  try {
    const result = await new PiRunner(provider.config, supervisor, nativeDiscoveryRenderer(supervisor)).run({ tokenBudget: 10000, enhancementMode: 'fullRewrite' as const, task: 'Task', purpose: 'investigation', initialContext: 'Fixture context', fileTree: '', currentPrompt: 'Fixture message', restrictsReviewGitToExplicitReadOnly: true, constraints: '', hints: [], roots: [] },
      { call: async call => { calls.push(call.name); return { kind: 'metadata', marker: 'reached-mipmux' }; } }, new AbortController().signal, () => {});
    assert.equal(result.kind, 'complete', JSON.stringify(result.kind === 'complete' ? null : result.code));
    assert(provider.requests[0]!.tools.includes('codemode'), provider.requests[0]!.tools.join(','));
    assert.deepEqual(calls, ['draft_inspect']);
    assert.deepEqual(result.receipt.completions.map(completion => completion.toolCalls), [['codemode'], []]);
    assert(JSON.stringify(provider.requests[1]!.messages.at(-1)).includes('reached-mipmux'));
  } finally { await supervisor.close(); await provider.close(); }
});
