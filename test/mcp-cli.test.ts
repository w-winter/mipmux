import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';

const command = resolve('dist/cli/main.js');
test('MCP exposes nonsecret artifact and membership targets usable by explicit CLI recovery', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(resolve('test-output/mcp-cache-'));
  const root = join(base, 'root'), outputRoot = join(base, 'out'), config = join(base, 'config.json');
  await mkdir(root); await mkdir(outputRoot);
  await writeFile(join(root, 'model.swift'), 'struct Model {\n let title: String\n}');
  const options = { cachePath: join(base, 'cache'), terminationGraceMs: 100, credentialPaths: [config], nativeEnvironment: {},
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`) };
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot };
  const runtime = new SmipRuntime(options);
  const handle = await runtime.declare(spec, new AbortController().signal);
  const inventory = await handle.refresh(new AbortController().signal);
  await handle.close(); await runtime.close();
  const entry = inventory.entries.find(entry => entry.kind === 'file');
  if (!entry || entry.kind !== 'file' || entry.structural.kind !== 'artifact') assert.fail('missing artifact');
  const artifactKey = entry.structural.key.digest, membershipKey = inventory.workspaceKey;
  const artifactPath = join(options.cachePath, 'v1/artifacts', artifactKey.slice(0, 2), artifactKey + '.json');
  const membershipPath = join(options.cachePath, 'v1/workspaces', membershipKey, 'membership.json');
  await writeFile(config, JSON.stringify({ ...options, search: null, git: null, discovery: null, defaultMaxOutputBytes: 10000 }));
  for (const kind of ['artifact', 'membership'] as const) {
    const key = kind === 'artifact' ? artifactKey : membershipKey;
    const path = kind === 'artifact' ? artifactPath : membershipPath;
    const unrelated = kind === 'artifact' ? membershipPath : artifactPath;
    const saved = await readFile(path), neighbor = await readFile(unrelated);
    await writeFile(path, 'synthetic corrupt record');
    const transport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'cache-recovery', version: '1' });
    try {
      await client.connect(transport);
      const declared = await client.callTool({ name: 'workspace_declare', arguments: { spec } });
      const result = kind === 'membership' ? declared : await client.callTool({ name: 'workspace_refresh',
        arguments: { workspaceId: JSON.parse(JSON.stringify(declared.structuredContent)).id } });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { kind: 'error', code: kind === 'artifact' ? 'cacheCorrupt' : 'membershipCorrupt', target: { kind, key } });
      await writeFile(join(base, kind + '-diagnostic.json'), JSON.stringify(result));
    } finally { await client.close(); }
    await promisify(execFile)(process.execPath, [command, 'cache', 'invalidate', '--kind', kind, '--key', key, '--config', config], { cwd: '/' });
    await assert.rejects(access(path));
    assert.deepEqual(await readFile(unrelated), neighbor);
    await writeFile(path, saved);
  }
});
test('official MCP negotiation and EOF create no workspace during probes; CLI inputs are explicit', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(resolve('test-output/mcp-cli-'));
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ cachePath: join(base, 'cache'), nativeExecutable: '/unavailable/native', nativeEnvironment: {},
    terminationGraceMs: 100, credentialPaths: [], search: null, git: null, discovery: null, defaultMaxOutputBytes: 12000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 16);
    const result = await client.callTool({ name: 'context_builder_result', arguments: { jobId: 'foreign' } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.structuredContent), /unknownJob/);
    await assert.rejects(access(join(base, 'cache')));
  } finally { await client.close(); }
  const eof = spawn(process.execPath, [command, 'mcp', '--config', config], { cwd: '/', stdio: 'pipe' });
  const stdout: Buffer[] = []; eof.stdout.on('data', chunk => stdout.push(chunk)); eof.stderr.resume();
  const closed = new Promise<number | null>(resolve => eof.once('close', resolve)); eof.stdin.end();
  assert.equal(await closed, 0); assert.equal(Buffer.concat(stdout).length, 0);
  await assert.rejects(access(join(base, 'cache')));
  const result = await promisify(execFile)(process.execPath, [command, 'verify', '--bundle', base, '--mode', 'integrity'], { cwd: '/' }).catch(error => error);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).kind, 'failed');
  assert(!result.stderr.includes('processSpawned'));
  await writeFile(join(base, 'receipt.json'), JSON.stringify({ listedTools: 16, eofCode: 0, integrityCode: result.code }));
});

test('MCP applies the host output allowance and EOF settles an active isolated discovery', async () => {
  let entered!: () => void, enteredTwo!: () => void, entering = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const startedTwo = new Promise<void>(resolve => { enteredTwo = resolve; });
  const provider = await scriptedProvider(() => ({ kind: 'hold', entered: () => { if (++entering === 1) entered(); else enteredTwo(); } }));
  const root = join(provider.directory, 'root'), output = join(provider.directory, 'out');
  await mkdir(root); await mkdir(output); await writeFile(join(root, 'file.txt'), 'source\n');
  const config = join(provider.directory, 'config.json');
  await writeFile(config, JSON.stringify({ cachePath: join(provider.directory, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, credentialPaths: [], search: null, git: null, discovery: provider.config, defaultMaxOutputBytes: 2000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1' });
  const diagnostics: Buffer[] = []; transport.stderr?.on('data', chunk => diagnostics.push(Buffer.from(chunk)));
  try {
    await client.connect(transport); await client.listTools();
    const protocolClose = transport.onclose;
    const closed = new Promise<void>(resolve => { transport.onclose = () => { protocolClose?.(); resolve(); }; });
    const declaration = await client.callTool({ name: 'workspace_declare', arguments: { spec: {
      roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] } } });
    const workspaceId = JSON.parse(JSON.stringify(declaration.structuredContent)).id;
    const read = await client.callTool({ name: 'read_file', arguments: { workspaceId,
      input: { root: 'r', path: 'file.txt', shape: { kind: 'whole' }, continuation: null } } });
    assert.equal(read.isError, false, JSON.stringify(read));
    assert(Buffer.byteLength(JSON.stringify(read)) <= 2000);
    const request = {
      task: 'Task', constraints: '', purpose: 'investigation', requiredSources: [], documents: [], patches: [], discoveryHints: [],
      allowance: { kind: 'net', units: 10000, method: 'utf8-21-over-80-v1', overheadReserved: true }, outputName: 'packet' };
    const first = await client.callTool({ name: 'context_builder', arguments: { workspaceId, requestId: 'one', request } });
    const firstId = JSON.parse(JSON.stringify(first.structuredContent)).jobId;
    await started;
    const observer = new AbortController();
    const waiting = client.callTool({ name: 'context_builder_wait', arguments: { jobId: firstId, durationMs: 10000 } }, { signal: observer.signal });
    const refused = assert.rejects(waiting);
    await client.callTool({ name: 'context_builder_result', arguments: { jobId: firstId } });
    observer.abort(); await refused;
    assert.equal(JSON.parse(JSON.stringify((await client.callTool({ name: 'context_builder_result', arguments: { jobId: firstId } })).structuredContent)).state, 'discovering');
    const second = await client.callTool({ name: 'context_builder', arguments: { workspaceId, requestId: 'two', request: { ...request, outputName: 'packet-two' } } });
    const secondId = JSON.parse(JSON.stringify(second.structuredContent)).jobId;
    await startedTwo;
    const progress: number[] = [];
    const secondWait = client.callTool({ name: 'context_builder_wait', arguments: { jobId: secondId, durationMs: 10000 } },
      { onprogress: value => { progress.push(value.progress); } });
    await client.callTool({ name: 'context_builder_result', arguments: { jobId: secondId } });
    await client.callTool({ name: 'context_builder_cancel', arguments: { jobId: secondId } });
    assert.equal(JSON.parse(JSON.stringify((await secondWait).structuredContent)).state, 'cancelled');
    assert(progress.length > 0); assert(progress.every((value, index) => index === 0 || value > progress[index - 1]!));
    assert.equal(JSON.parse(JSON.stringify((await client.callTool({ name: 'context_builder_result', arguments: { jobId: firstId } })).structuredContent)).state, 'discovering');
    await client.close(); await closed;
    const records = Buffer.concat(diagnostics).toString().trim().split('\n').map(line => JSON.parse(line));
    const spawned = records.filter(record => record.event === 'processSpawned').map(record => record.id).sort();
    const joined = records.filter(record => record.event === 'processClosed').map(record => record.id).sort();
    assert.deepEqual(joined, spawned); assert(spawned.length > 1);
    assert(records.some(record => record.event === 'jobState' && record.state === 'cancelled'));
    await writeFile(join(provider.directory, 'eof-receipt.json'), JSON.stringify({ spawned, joined }));
  } finally { await client.close(); await provider.close(); }
});
