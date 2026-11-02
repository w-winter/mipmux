import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const pi = fileURLToPath(new URL('./bundle/cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
const Frame = Compile(Type.Object({ type: Type.String(), id: Type.Optional(Type.String()),
  data: Type.Optional(Type.Object({ disposition: Type.Optional(Type.String()) })) }));
const promptTimeoutMs = 60_000;
const discoveryModel = 'anthropic/claude-haiku-4-5';
const conflictNote = 'use a new outputName or restore the earlier preferences';

/** Pi in RPC mode with only its MCP support, this extension and the scripted provider, in a private home and agent folder. */
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
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--model', 'scripted/scripted-model'],
  { cwd: project, env: { ...inherited, HOME: base, PI_CODING_AGENT_DIR: agentDir, MIPMUX_TEST_PROVIDER_LOG: providerLog },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  // Prompts run one at a time: a handled prompt finishes with its response, and a started run with the next agent_settled.
  const current = { finish: (_frame: string): void => {}, settling: false };
  void (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      const frame: unknown = JSON.parse(line);
      if (!Frame.Check(frame)) continue;
      if (frame.type === 'response' && frame.id !== undefined) {
        if (frame.data?.disposition === 'handled') current.finish(line);
        else current.settling = true;
      } else if (frame.type === 'agent_settled' && current.settling) {
        current.settling = false;
        current.finish(line);
      }
    }
  })();
  /** Sends `message` as a prompt and resolves once Pi has finished with it. */
  const prompt = (id: string, message: string) => Promise.race([new Promise<string>(resolve => {
    current.finish = resolve;
    child.stdin.write(JSON.stringify({ id, type: 'prompt', message }) + '\n');
  }), new Promise<never>((_resolve, reject) => {
    setTimeout(() => { reject(new Error(`prompt ${id} took over ${promptTimeoutMs} ms; pi stderr:\n${stderr}`)); }, promptTimeoutMs).unref();
  })]);
  const lines = async (path: string): Promise<unknown[]> => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { declaration, prompt, serverCalls: () => lines(serverLog), providerRequests: () => lines(providerLog), stop: () => child.kill() };
}

test('Pi applies the saved workspace to mipmux calls, publishes it as a prompt section, blocks other workspaces and notes a conflict it caused',
  { timeout: promptTimeoutMs * 5 }, async () => {
    const session = await start();
    try {
      const other = { ...session.declaration, outputRoot: join(tmpdir(), 'elsewhere') };
      const build = (workspace: typeof session.declaration, outputName: string) =>
        JSON.stringify({ tool: 'mcp__mipmux__context_builder', arguments: { workspace, purpose: 'planning', task: 'Plan', outputName } });
      for (const [id, message] of [['select', '/mipmux app'], ['applied', build(session.declaration, 'run-1')],
        ['blocked', build(other, 'run-2')], ['conflict', build(session.declaration, 'taken')]] as const) await session.prompt(id, message);

      const calls = await session.serverCalls();
      assert.deepEqual(calls.map(call => JSON.stringify(call)), ['run-1', 'taken'].map(outputName => JSON.stringify({ name: 'context_builder',
        arguments: { workspace: session.declaration, purpose: 'planning', task: 'Plan', outputName, discovery: { model: discoveryModel } } })),
      'only calls naming the selected workspace reach mipmux, each with the saved workspace\'s model');
      const requests = (await session.providerRequests()).map(request => JSON.stringify(request));
      assert(requests[0]?.includes('The user selected the mipmux workspace \\"app\\"'), 'the first request carries the workspace section');
      const results = requests.filter(request => request.includes('"last":{"role":"toolResult"'));
      assert.equal(results.length, 3);
      assert.match(results[0] ?? '', /\\"kind\\":\\"started\\"/);
      // The log holds each result's text inside JSON, so the declaration in a block reason appears escaped.
      assert((results[1] ?? '').includes(JSON.stringify(JSON.stringify(session.declaration)).slice(1, -1)), 'the blocked result names the selected workspace');
      assert((results[2] ?? '').includes(conflictNote), 'the conflict result carries the note');

      await mkdir(join(packageRoot, 'test-output'), { recursive: true });
      await writeFile(join(packageRoot, 'test-output/pi-rpc.json'), JSON.stringify({ calls, results }, null, 2) + '\n');
    } finally { session.stop(); }
  });
