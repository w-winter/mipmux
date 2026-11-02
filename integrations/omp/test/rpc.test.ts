import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const omp = fileURLToPath(new URL('./cli.ts', import.meta.resolve('@oh-my-pi/pi-coding-agent')));
// pi-mipmux's stand-in for the mipmux server, shared by both extensions' RPC tests.
const standInServer = join(packageRoot, '../pi/test/fixtures/stand-in-server.ts');
const Frame = Compile(Type.Object({ type: Type.String(), id: Type.Optional(Type.String()) }));
const promptTimeoutMs = 60_000;
const discoveryModel = 'anthropic/claude-haiku-4-5';
const conflictNote = 'use a new outputName or restore the earlier preferences';

/** omp in RPC mode with this extension, the scripted provider and the stand-in mipmux server, in a private agent folder. */
async function start() {
  const base = await mkdtemp(join(tmpdir(), 'omp-mipmux-rpc-')), agentDir = join(base, 'agent'), project = join(base, 'app');
  const output = join(project, 'prompt-exports'), serverLog = join(base, 'server.jsonl'), providerLog = join(base, 'provider.jsonl');
  await mkdir(agentDir); await mkdir(output, { recursive: true });
  await writeFile(serverLog, ''); await writeFile(providerLog, '');
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { mipmux: { command: process.execPath,
    args: [standInServer], env: { MIPMUX_TEST_SERVER_LOG: serverLog } } } }));
  const declaration = { roots: [{ name: 'app', absolutePath: project }], outputRoot: output, exclusions: [] };
  await writeFile(join(agentDir, 'mipmux.json'), JSON.stringify({ workspaces: [{ name: 'app', roots: declaration.roots, outputRoot: output,
    model: { value: discoveryModel, pinned: false } }] }));
  // The caller's own Pi or omp settings, such as a Pi session's PI_CODING_AGENT_DIR, must not reach this omp, and omp keeps
  // logs, caches and plugins under HOME whatever its agent folder, so HOME is the scratch folder too.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PI_') && !name.startsWith('OMP_')));
  const child = spawn(process.execPath, [omp, '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-rules',
    '--no-context-files', '--no-title', '--no-lsp', '--model', 'scripted/scripted-model',
    '-e', join(packageRoot, 'src/extension.ts'), '-e', join(packageRoot, 'test/fixtures/scripted-provider.ts')],
  { cwd: project, env: { ...inherited, HOME: base, PI_CODING_AGENT_DIR: agentDir, MIPMUX_TEST_PROVIDER_LOG: providerLog },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const waiting = new Map<string, (frame: string) => void>();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  void (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      const frame: unknown = JSON.parse(line);
      if (!Frame.Check(frame)) continue;
      if (frame.type === 'ready') ready();
      if (frame.type === 'prompt_result' && frame.id !== undefined) waiting.get(frame.id)?.(line);
    }
  })();
  const settle = <T>(work: Promise<T>, what: string) => Promise.race([work, new Promise<never>((_resolve, reject) => {
    setTimeout(() => { reject(new Error(`${what} took over ${promptTimeoutMs} ms; omp stderr:\n${stderr}`)); }, promptTimeoutMs).unref();
  })]);
  await settle(started, 'starting omp');
  /** Sends `message` as a prompt and resolves with its prompt_result frame once the run it started has settled. */
  const prompt = (id: string, message: string) => settle(new Promise<string>(resolve => {
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, type: 'prompt', message }) + '\n');
  }), `prompt ${id}`);
  const lines = async (path: string): Promise<unknown[]> => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  /** Stops omp and removes its scratch folder, which omp fills with its own logs and caches. */
  async function stop(): Promise<void> {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit');
    child.kill();
    await exited;
    await rm(base, { recursive: true, force: true });
  }
  return { declaration, prompt, serverCalls: () => lines(serverLog), providerRequests: () => lines(providerLog), stop };
}

test('omp applies the saved workspace to mipmux calls, blocks other workspaces under either tool name, and notes a conflict it caused',
  { timeout: promptTimeoutMs * 6 }, async () => {
    const omp = await start();
    try {
      const other = { ...omp.declaration, outputRoot: join(tmpdir(), 'elsewhere') };
      const build = (tool: string, workspace: typeof omp.declaration, outputName: string) =>
        JSON.stringify({ tool, arguments: { workspace, purpose: 'planning', task: 'Plan', outputName } });
      for (const [id, message] of [['select', '/mipmux app'], ['applied', build('mcp__mipmux_context_builder', omp.declaration, 'run-1')],
        ['blocked', build('mcp__mipmux_context_builder', other, 'run-2')], ['pi-name', build('mcp__mipmux__context_builder', other, 'run-3')],
        ['conflict', build('mcp__mipmux_context_builder', omp.declaration, 'taken')]] as const) {
        assert.match(await omp.prompt(id, message), /"status":"completed"/, id);
      }

      const calls = await omp.serverCalls();
      assert.deepEqual(calls.map(call => JSON.stringify(call)), ['run-1', 'taken'].map(outputName => JSON.stringify({ name: 'context_builder',
        arguments: { workspace: omp.declaration, purpose: 'planning', task: 'Plan', outputName, discovery: { model: discoveryModel } } })),
      'only calls naming the selected workspace reach mipmux, each with the saved workspace\'s model');
      const requests = (await omp.providerRequests()).map(request => JSON.stringify(request));
      const results = requests.filter(request => request.includes('"role":"toolResult"'));
      assert.equal(results.length, 4);
      assert.match(results[0] ?? '', /\\"kind\\":\\"started\\"/);
      // The log holds each result's text inside JSON, so the declaration in a block reason appears escaped.
      const selectedDeclaration = JSON.stringify(JSON.stringify(omp.declaration)).slice(1, -1);
      for (const index of [1, 2]) assert((results[index] ?? '').includes(selectedDeclaration), `result ${index} is a block naming the selected workspace`);
      assert((results[3] ?? '').includes(conflictNote), 'the conflict result carries the note');
      const workspaceBlock = '<mipmux_workspace>\\nThe user selected the mipmux workspace \\"app\\"';
      assert(requests.every(request => request.includes(workspaceBlock)), 'every request after the selection carries the workspace block');

      await mkdir(join(packageRoot, 'test-output'), { recursive: true });
      await writeFile(join(packageRoot, 'test-output/omp-rpc.json'), JSON.stringify({ calls, results }, null, 2) + '\n');
    } finally { await omp.stop(); }
  });
