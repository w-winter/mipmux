import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import { MipmuxRuntime } from '../src/runtime/mipmux-runtime.js';
import { toolJSON } from './fixtures/tool-json.js';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const command = resolve('dist/cli/main.js');
const coreTools = ['context_builder', 'context_job', 'context_prepare'];
const fullTools = [...coreTools, 'draft_create', 'draft_dispose', 'draft_finalize', 'draft_inspect', 'draft_update', 'draft_validate',
  'file_search', 'get_code_structure', 'get_file_tree', 'git', 'manage_selection', 'prompt', 'read_file', 'workspace_close',
  'workspace_declare', 'workspace_refresh'].sort();
test('MCP exposes nonsecret artifact and reuse targets usable by explicit CLI recovery', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-mcp-cache-'));
  const root = join(base, 'root'), outputRoot = join(base, 'out'), config = join(base, 'config.json');
  await mkdir(root); await mkdir(outputRoot);
  await writeFile(join(root, 'model.swift'), 'struct Model {\n let title: String\n}');
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [config], nativeEnvironment: {},
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`) };
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot };
  const runtime = new MipmuxRuntime(options);
  const handle = await runtime.declare(spec, new AbortController().signal);
  const inventory = await handle.refresh(new AbortController().signal);
  await handle.close(); await runtime.close();
  const entry = inventory.entries.find(entry => entry.kind === 'file');
  if (!entry || entry.kind !== 'file' || entry.structural.kind !== 'artifact') assert.fail('missing artifact');
  const artifactKey = entry.structural.key.digest, reuseKey = inventory.workspaceKey;
  const artifactPath = join(options.cachePath, 'v1/artifacts', artifactKey.slice(0, 2), artifactKey + '.json');
  const reusePath = join(options.cachePath, 'v1/workspaces', reuseKey, 'reuse.json');
  await writeFile(config, JSON.stringify({ ...options, git: null, discovery: null, defaultMaxOutputBytes: 10000 }));
  for (const kind of ['artifact', 'reuse'] as const) {
    const key = kind === 'artifact' ? artifactKey : reuseKey;
    const path = kind === 'artifact' ? artifactPath : reusePath;
    const unrelated = kind === 'artifact' ? reusePath : artifactPath;
    const saved = await readFile(path), neighbor = await readFile(unrelated);
    await writeFile(path, 'synthetic corrupt record');
    const transport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp', '--tools', 'full', '--config', config], cwd: '/', stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'cache-recovery', version: '1' });
    try {
      await client.connect(transport);
      const declared = await client.callTool({ name: 'workspace_declare', arguments: { spec } });
      const result = await client.callTool({ name: 'workspace_refresh',
        arguments: { workspaceId: JSON.parse(JSON.stringify(toolJSON(declared))).id } });
      assert.equal(result.isError, true);
      assert.deepEqual(toolJSON(result), { kind: 'error', code: 'cacheCorrupt', target: { kind, key } });
      await writeFile(join(base, kind + '-diagnostic.json'), JSON.stringify(result));
    } finally { await client.close(); }
    await promisify(execFile)(process.execPath, [command, 'cache', 'invalidate', '--kind', kind, '--key', key, '--config', config], { cwd: '/' });
    await assert.rejects(access(path));
    assert.deepEqual(await readFile(unrelated), neighbor);
    await writeFile(path, saved);
  }
});
test('official MCP probes accept disabled provider deadlines and create no workspace; CLI inputs are explicit', async t => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-mcp-cli-'));
  const provider = await scriptedProvider(() => { throw new Error('No discovery request permitted during probes'); });
  t.after(() => provider.close());
  provider.config.policy.retry.provider.timeoutMs = 0;
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(base, 'cache'), nativeExecutable: '/unavailable/native', nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], git: null, discovery: provider.config, defaultMaxOutputBytes: 12000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const core: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
  try {
    await client.connect(transport);
    const instructions = client.getInstructions() ?? '';
    const manifest = Compile(Type.Object({ version: Type.String() })).Parse(JSON.parse(await readFile('package.json', 'utf8')));
    assert.equal(client.getServerVersion()?.version, manifest.version);
    assert.match(instructions, /^mipmux builds verified context packets/);
    // Claude Code releases before 2.1.296 discard server instructions past 2,048 characters.
    assert(instructions.length <= 2048, String(instructions.length));
    core.push(...(await client.listTools()).tools);
    assert.deepEqual(core.map(tool => tool.name).sort(), coreTools);
    const result = await client.callTool({ name: 'context_job', arguments: { op: 'status', jobId: 'foreign' } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(toolJSON(result)), /unknownJob/);
    await assert.rejects(access(join(base, 'cache')));
    await writeFile('test-output/caller-tools.json', JSON.stringify({ instructions,
      tools: core.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }, null, 2) + '\n');
  } finally { await client.close(); }
  const fullConfig = join(base, 'full-config.json');
  await writeFile(fullConfig, JSON.stringify({ ...JSON.parse(await readFile(config, 'utf8')), tools: 'full' }));
  const fullClient = new Client({ name: 'test', version: '1' });
  try {
    await fullClient.connect(new StdioClientTransport({ command: process.execPath, args: [command, 'mcp', '--config', fullConfig], cwd: '/', stderr: 'pipe' }));
    const full = (await fullClient.listTools()).tools;
    assert.deepEqual(full.map(tool => tool.name).sort(), fullTools);
    // Claude Code skips a tool whose input schema composes alternatives at the root ("top-level anyOf, which the Anthropic API does not accept").
    for (const tool of full) {
      for (const keyword of ['anyOf', 'oneOf', 'allOf']) assert(!(keyword in tool.inputSchema), `${tool.name} composes ${keyword} at its schema root`);
    }
    // Key order inside a schema depends on the negotiated protocol version, so the declarations compare as values.
    const declarations = (tools: typeof full) => tools.filter(tool => coreTools.includes(tool.name))
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(declarations(full), declarations(core));
  } finally { await fullClient.close(); }
  const eof = spawn(process.execPath, [command, 'mcp', '--config', config], { cwd: '/', stdio: 'pipe' });
  const stdout: Buffer[] = []; eof.stdout.on('data', chunk => stdout.push(chunk)); eof.stderr.resume();
  const closed = new Promise<number | null>(resolve => eof.once('close', resolve)); eof.stdin.end();
  assert.equal(await closed, 0); assert.equal(Buffer.concat(stdout).length, 0);
  await assert.rejects(access(join(base, 'cache')));
  const result = await promisify(execFile)(process.execPath, [command, 'verify', '--bundle', base, '--mode', 'integrity'], { cwd: '/' }).catch(error => error);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).kind, 'failed');
  assert(!result.stderr.includes('processSpawned'));
  assert.equal(provider.requests.length, 0);
  await writeFile(join(base, 'receipt.json'), JSON.stringify({ listedTools: coreTools.length, eofCode: 0, integrityCode: result.code }));
});

test('MCP applies the host output allowance and EOF settles an active isolated discovery', async () => {
  let entered!: () => void, enteredTwo!: () => void, entering = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const startedTwo = new Promise<void>(resolve => { enteredTwo = resolve; });
  const provider = await scriptedProvider(() => ({ kind: 'hold', entered: () => { if (++entering === 1) entered(); else enteredTwo(); } }));
  const root = join(provider.directory, 'root'), output = join(provider.directory, 'out');
  await mkdir(root); await mkdir(output); await writeFile(join(root, 'file.txt'), 'source\n');
  const config = join(provider.directory, 'config.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(provider.directory, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], git: null, discovery: provider.config, defaultMaxOutputBytes: 2000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp', '--tools', 'full', '--config', config], cwd: '/', stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1' });
  const diagnostics: Buffer[] = []; transport.stderr?.on('data', chunk => diagnostics.push(Buffer.from(chunk)));
  try {
    await client.connect(transport); await client.listTools();
    const protocolClose = transport.onclose;
    const closed = new Promise<void>(resolve => { transport.onclose = () => { protocolClose?.(); resolve(); }; });
    const spec = { roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] };
    const declaration = await client.callTool({ name: 'workspace_declare', arguments: { spec } });
    const workspaceId = JSON.parse(JSON.stringify(toolJSON(declaration))).id;
    const read = await client.callTool({ name: 'read_file', arguments: { workspaceId,
      input: { root: 'r', path: 'file.txt', start_line: null, offset: null, limit: null, continuation: null } } });
    assert.equal(read.isError, false, JSON.stringify(read));
    assert(Buffer.byteLength(JSON.stringify(read)) <= 2000);
    const request = { workspace: spec, task: 'Task', purpose: 'investigation', outputName: 'packet' };
    const first = await client.callTool({ name: 'context_builder', arguments: request });
    const firstId = JSON.parse(JSON.stringify(toolJSON(first))).jobId;
    await started;
    const observer = new AbortController();
    const waiting = client.callTool({ name: 'context_job', arguments: { op: 'wait', jobId: firstId, durationMs: 10000 } }, { signal: observer.signal });
    const refused = assert.rejects(waiting);
    await client.callTool({ name: 'context_job', arguments: { op: 'status', jobId: firstId } });
    observer.abort(); await refused;
    assert.equal(JSON.parse(JSON.stringify(toolJSON(await client.callTool({ name: 'context_job', arguments: { op: 'status', jobId: firstId } })))).state, 'discovering');
    const second = await client.callTool({ name: 'context_builder', arguments: { ...request, outputName: 'packet-two' } });
    const secondId = JSON.parse(JSON.stringify(toolJSON(second))).jobId;
    await startedTwo;
    const progress: number[] = [];
    const secondWait = client.callTool({ name: 'context_job', arguments: { op: 'wait', jobId: secondId, durationMs: 10000 } },
      { onprogress: value => { progress.push(value.progress); } });
    await client.callTool({ name: 'context_job', arguments: { op: 'status', jobId: secondId } });
    await client.callTool({ name: 'context_job', arguments: { op: 'cancel', jobId: secondId } });
    assert.equal(JSON.parse(JSON.stringify(toolJSON(await secondWait))).state, 'cancelled');
    assert(progress.length > 0); assert(progress.every((value, index) => index === 0 || value > progress[index - 1]!));
    assert.equal(JSON.parse(JSON.stringify(toolJSON(await client.callTool({ name: 'context_job', arguments: { op: 'status', jobId: firstId } })))).state, 'discovering');
    await client.close(); await closed;
    const records = Buffer.concat(diagnostics).toString().trim().split('\n').map(line => JSON.parse(line));
    const spawned = records.filter(record => record.event === 'processSpawned').map(record => record.id).sort();
    const joined = records.filter(record => record.event === 'processClosed').map(record => record.id).sort();
    assert.deepEqual(joined, spawned); assert(spawned.length > 1);
    assert(records.some(record => record.event === 'jobState' && record.state === 'cancelled'));
    await writeFile(join(provider.directory, 'eof-receipt.json'), JSON.stringify({ spawned, joined }));
  } finally { await client.close(); await provider.close(); }
});
