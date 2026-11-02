import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import type { CallArgs } from '../src/state.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const pi = fileURLToPath(new URL('./bundle/cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
const FrameSchema = Type.Object({ type: Type.String(), id: Type.Optional(Type.String()),
  data: Type.Optional(Type.Object({ disposition: Type.Optional(Type.String()) })) });
const Frame = Compile(FrameSchema);
type Frame = Static<typeof FrameSchema>;
const promptTimeoutMs = 60_000;
const pollMs = 20;
const discoveryModel = 'anthropic/claude-haiku-4-5';
const conflictNote = 'use a new outputName or restore the earlier preferences';

/**
 * Pi in RPC mode with only its MCP support, this extension, the scripted provider and the pi-queue-steer stand-in, in a
 * private home and agent folder.
 */
async function start() {
  const base = await mkdtemp(join(tmpdir(), 'pi-mipmux-rpc-')), agentDir = join(base, 'agent'), project = join(base, 'app');
  const output = join(project, 'prompt-exports'), serverLog = join(base, 'server.jsonl'), providerLog = join(base, 'provider.jsonl');
  await mkdir(agentDir); await mkdir(output, { recursive: true });
  await writeFile(serverLog, ''); await writeFile(providerLog, '');
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { mipmux: { command: process.execPath, exposure: 'direct',
    args: ['--experimental-strip-types', join(packageRoot, 'test/fixtures/stand-in-server.ts')], env: { MIPMUX_TEST_SERVER_LOG: serverLog } } } }));
  const declaration = { roots: [{ name: 'app', absolutePath: project }], outputRoot: output, exclusions: [] };
  await writeFile(join(agentDir, 'mipmux.json'), JSON.stringify({ workspaces: [{ name: 'app', roots: declaration.roots, outputRoot: output,
    model: { value: discoveryModel, pinned: false } }] }));
  // The caller's own Pi settings, such as a Pi session's PI_CODING_AGENT_DIR, must not reach this Pi.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PI_')));
  const child = spawn(process.execPath, [pi, '--mode', 'rpc', '--no-session', '--offline', '--no-extensions', '-e', 'builtin:mcp',
    '-e', join(packageRoot, 'src/extension.ts'), '-e', join(packageRoot, 'test/fixtures/scripted-provider.ts'),
    '-e', join(packageRoot, 'test/fixtures/queue-steer.ts'),
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--model', 'scripted/scripted-model'],
  { cwd: project, env: { ...inherited, HOME: base, PI_CODING_AGENT_DIR: agentDir, MIPMUX_TEST_PROVIDER_LOG: providerLog },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  // Every frame Pi wrote, in order, so a wait can look for frames that arrived before it started.
  const frames: Frame[] = [];
  void (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      const frame: unknown = JSON.parse(line);
      if (Frame.Check(frame)) frames.push(frame);
    }
  })();
  /** Resolves with the result of `check` once it is not undefined, polling every `pollMs`. */
  async function until<T>(what: string, check: () => T | undefined | Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + promptTimeoutMs;
    for (;;) {
      const found = await check();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out after ${promptTimeoutMs} ms waiting for ${what}; pi stderr:\n${stderr}`);
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
  const frameAfter = (from: number, what: string, match: (frame: Frame) => boolean) => until(what, () => frames.slice(from).find(match));
  /** Sends `command` and resolves with Pi's response to it. */
  async function send(command: { readonly id: string; readonly type: string; readonly message: string }): Promise<Frame> {
    const from = frames.length;
    child.stdin.write(JSON.stringify(command) + '\n');
    return frameAfter(from, `response to ${command.id}`, frame => frame.type === 'response' && frame.id === command.id);
  }
  /** Sends `message` as a prompt and resolves once Pi has finished with it: at once when handled, else when the run settles. */
  async function prompt(id: string, message: string): Promise<void> {
    const from = frames.length, response = await send({ id, type: 'prompt', message });
    if (response.data?.disposition !== 'handled') await frameAfter(from, `the end of prompt ${id}`, frame => frame.type === 'agent_settled');
  }
  const lines = async (path: string): Promise<unknown[]> => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  /** Stops Pi and removes its scratch folder, which Pi fills with its own logs and caches. */
  async function stop(): Promise<void> {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit');
    child.kill();
    await exited;
    await rm(base, { recursive: true, force: true });
  }
  return { declaration, prompt, send, until, serverCalls: () => lines(serverLog), providerRequests: () => lines(providerLog), stop };
}

const scripted = (tool: string, args: CallArgs) => JSON.stringify({ tool, arguments: args });
const ProviderRequest = Compile(Type.Object({ transcript: Type.Array(Type.Object({ role: Type.String() })) }));
/** The provider log entries whose last message is a tool result, as JSON text, in order. */
async function toolResults(session: Awaited<ReturnType<typeof start>>): Promise<string[]> {
  return (await session.providerRequests()).map(request => JSON.stringify(request)).filter(request => request.includes('"last":{"role":"toolResult"'));
}

test('Pi applies the saved workspace to mipmux calls, publishes it as a prompt section, blocks other workspaces and notes a conflict it caused',
  { timeout: promptTimeoutMs * 5 }, async () => {
    const session = await start();
    try {
      const other = { ...session.declaration, outputRoot: join(tmpdir(), 'elsewhere') };
      const build = (workspace: typeof session.declaration, outputName: string) =>
        scripted('mcp__mipmux__context_builder', { workspace, purpose: 'planning', task: 'Plan', outputName });
      for (const [id, message] of [['select', '/mipmux app'], ['applied', build(session.declaration, 'run-1')],
        ['blocked', build(other, 'run-2')], ['conflict', build(session.declaration, 'taken')]] as const) await session.prompt(id, message);

      const calls = await session.serverCalls();
      assert.deepEqual(calls.map(call => JSON.stringify(call)), ['run-1', 'taken'].map(outputName => JSON.stringify({ name: 'context_builder',
        arguments: { workspace: session.declaration, purpose: 'planning', task: 'Plan', outputName, discovery: { model: discoveryModel } } })),
      'only calls naming the selected workspace reach mipmux, each with the saved workspace\'s model');
      const requests = (await session.providerRequests()).map(request => JSON.stringify(request));
      assert(requests[0]?.includes('The user selected the mipmux workspace \\"app\\"'), 'the first request carries the workspace section');
      const results = await toolResults(session);
      assert.equal(results.length, 3);
      assert.match(results[0] ?? '', /\\"kind\\":\\"started\\"/);
      // The log holds each result's text inside JSON, so the declaration in a block reason appears escaped.
      assert((results[1] ?? '').includes(JSON.stringify(JSON.stringify(session.declaration)).slice(1, -1)), 'the blocked result names the selected workspace');
      assert((results[2] ?? '').includes(conflictNote), 'the conflict result carries the note');

      await mkdir(join(packageRoot, 'test-output'), { recursive: true });
      await writeFile(join(packageRoot, 'test-output/pi-rpc.json'), JSON.stringify({ calls, results }, null, 2) + '\n');
    } finally { await session.stop(); }
  });

test('mipmux_wait waits like context_job, a steering message or pi-queue-steer ends the wait but not the job, and a plain wait is blocked',
  { timeout: promptTimeoutMs * 6 }, async () => {
    const session = await start();
    // Long enough that only an interruption can end the wait before the test does.
    const longWaitMs = 30_000;
    const waitFor = (durationMs: number) => scripted('mipmux_wait', { jobId: 'job-1', durationMs });
    /** Starts a long wait as prompt `id`, calls `interrupt` once mipmux holds it, and resolves when the prompt has finished. */
    async function interruptedWait(id: string, interrupt: () => Promise<void>): Promise<void> {
      const before = (await session.serverCalls()).length;
      const running = session.prompt(id, waitFor(longWaitMs));
      await session.until(`the ${id} wait at the server`, async () => (await session.serverCalls()).length > before ? true : undefined);
      await interrupt();
      await running;
    }
    try {
      await session.prompt('plain', scripted('mcp__mipmux__context_job', { op: 'wait', jobId: 'job-1', durationMs: 1000 }));
      await session.prompt('quick', waitFor(10));
      await interruptedWait('steered', async () => { await session.send({ id: 'steer', type: 'steer',
        message: scripted('mcp__mipmux__context_job', { op: 'status', jobId: 'job-1' }) }); });
      await interruptedWait('queued', () => session.prompt('accept', '/accept-steer'));

      const wait = (durationMs: number) => ({ name: 'context_job', arguments: { op: 'wait', jobId: 'job-1', durationMs } });
      assert.deepEqual(await session.serverCalls(), [wait(10), wait(longWaitMs), { cancelled: wait(longWaitMs).arguments },
        { name: 'context_job', arguments: { op: 'status', jobId: 'job-1' } }, wait(longWaitMs), { cancelled: wait(longWaitMs).arguments }],
      'the plain wait never reaches mipmux, each interrupted wait is cancelled there, and the steering message runs after it');
      // A steering message arrives together with the interrupted result, so the results come from the whole transcript.
      const last = (await session.providerRequests()).at(-1);
      assert(ProviderRequest.Check(last));
      const results = last.transcript.filter(message => message.role === 'toolResult').map(message => JSON.stringify(message));
      assert.equal(results.length, 5);
      assert.match(results[0] ?? '', /mipmux_wait/, 'the plain wait is blocked with a reason naming mipmux_wait');
      assert.match(results[1] ?? '', /\\"state\\":\\"discovering\\"/, 'a wait that ends on its own returns mipmux\'s reply');
      for (const index of [2, 4]) {
        assert.match(results[index] ?? '', /the job is still running/, `result ${index} reports an interrupted wait`);
        assert.match(results[index] ?? '', /"isError":false/, `result ${index} is an ordinary result, not an error`);
      }
      assert.match(results[3] ?? '', /\\"state\\":\\"discovering\\"/, 'the steering message\'s status call reaches mipmux');

      await mkdir(join(packageRoot, 'test-output'), { recursive: true });
      await writeFile(join(packageRoot, 'test-output/pi-rpc-wait.json'), JSON.stringify({ calls: await session.serverCalls(), results }, null, 2) + '\n');
    } finally { await session.stop(); }
  });
