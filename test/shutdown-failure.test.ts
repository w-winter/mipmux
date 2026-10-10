import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import type { ProcessSpec } from '../src/runtime/process-supervisor.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpServer } from '../src/mcp/server.js';

for (const trigger of ['EOF', 'SIGINT'] as const) test(`stdio ${trigger} propagates joined transport failure through the sanitized CLI outcome`, async () => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(resolve('test-output/shutdown-failure-'));
  const config = join(directory, 'config.json'), proof = join(directory, 'proof.txt');
  await writeFile(config, JSON.stringify({ cachePath: join(directory, 'cache'), nativeExecutable: '/unavailable/native', nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], search: null, git: null, discovery: null, defaultMaxOutputBytes: 12000 }));
  const child = spawn(process.execPath, ['--import', resolve('test/fixtures/shutdown-failure.mjs'), resolve('dist/cli/main.js'), 'mcp', '--config', config],
    { stdio: 'pipe', env: { ...process.env, SMIP_SHUTDOWN_PROOF: proof } });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on('data', bytes => stdout.push(Buffer.from(bytes))); child.stderr.on('data', bytes => stderr.push(Buffer.from(bytes)));
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  if (trigger === 'EOF') child.stdin.end();
  else {
    child.stdout.on('data', () => child.kill('SIGINT'));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'shutdown', version: '1' } } }) + '\n');
  }
  const code = await closed;
  const records = await readFile(proof, 'utf8');
  assert(records.includes('transportJoined'));
  assert(!records.includes('unhandledRejection'));
  assert.equal(code, 1);
  if (trigger === 'EOF') assert.equal(Buffer.concat(stdout).length, 0);
  else for (const line of Buffer.concat(stdout).toString().trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  const errors = Buffer.concat(stderr).toString();
  assert(errors.includes('"kind":"failed"'));
  assert(!errors.includes('synthetic transport close failure'));
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ code, records, stderr: errors, stdoutBytes: 0 }));
});

test('MCP server-close rejects the exported closed outcome after joining application and client resources', async t => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(resolve('test-output/shutdown-application-'));
  const root = join(directory, 'root'), out = join(directory, 'out');
  await mkdir(root); await mkdir(out); await writeFile(join(root, 'file.txt'), 'source');
  const processes: Promise<unknown>[] = [];
  const spawn = ProcessSupervisor.prototype.spawn;
  let fail = false, injected = false;
  t.mock.method(ProcessSupervisor.prototype, 'spawn', function (this: ProcessSupervisor, spec: ProcessSpec) {
    const owned = spawn.call(this, spec); processes.push(owned.closed);
    return { ...owned, stop: async () => {
      const receipt = await owned.stop();
      if (fail && !injected) { injected = true; throw new Error('synthetic application cleanup failure'); }
      return receipt;
    } };
  });
  const instance = createMcpServer({ cachePath: join(directory, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], search: null, git: null, discovery: null, defaultMaxOutputBytes: 12000 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'shutdown', version: '1' });
  await instance.server.connect(serverTransport); await client.connect(clientTransport);
  const declared = await client.callTool({ name: 'workspace_declare', arguments: { spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out } } });
  assert.equal(declared.isError, false);
  fail = true;
  const outcome = assert.rejects(instance.closed, /synthetic application cleanup failure/);
  await instance.server.close();
  await outcome;
  await assert.rejects(instance.close(), /synthetic application cleanup failure/);
  assert.equal(instance.close(), instance.close());
  await Promise.all(processes);
  await client.close();
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ joined: processes.length, injected, rejected: true }));
});

test('a reported malformed MCP input does not turn later successful EOF cleanup into a shutdown failure', async () => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(resolve('test-output/shutdown-protocol-'));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ cachePath: join(directory, 'cache'), nativeExecutable: '/unavailable/native', nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], search: null, git: null, discovery: null, defaultMaxOutputBytes: 12000 }));
  const child = spawn(process.execPath, [resolve('dist/cli/main.js'), 'mcp', '--config', config], { stdio: 'pipe' });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let initialized = false;
  child.stderr.on('data', bytes => {
    stderr.push(Buffer.from(bytes));
    if (!initialized && Buffer.concat(stderr).toString().includes('mcpTransportError')) {
      initialized = true;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'shutdown', version: '1' } } }) + '\n');
    }
  });
  child.stdout.on('data', bytes => { stdout.push(Buffer.from(bytes)); child.stdin.end(); });
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  child.stdin.write('{}\n');
  assert.equal(await closed, 0);
  assert.equal(JSON.parse(Buffer.concat(stdout).toString()).jsonrpc, '2.0');
  assert(!Buffer.concat(stderr).toString().includes('"kind":"failed"'));
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ initialized, code: 0 }));
});

test('runtime joins all real child closures after a process cleanup failure', async t => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(resolve('test-output/shutdown-processes-'));
  const root = join(directory, 'root'), out = join(directory, 'out');
  await mkdir(root); await mkdir(out); await writeFile(join(root, 'file.txt'), 'source');
  const runtime = new SmipRuntime({ cachePath: join(directory, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {} });
  const spawn = runtime.supervisor.spawn.bind(runtime.supervisor);
  let fail = false, injected = false;
  const processes: Promise<unknown>[] = [];
  t.mock.method(runtime.supervisor, 'spawn', (spec: ProcessSpec) => {
    const owned = spawn(spec); processes.push(owned.closed);
    return { ...owned, stop: async () => {
      const receipt = await owned.stop();
      if (fail && !injected) { injected = true; throw new Error('synthetic process cleanup failure'); }
      return receipt;
    } };
  });
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], outputRoot: out, exclusions: [] }, new AbortController().signal);
  await workspace.refresh(new AbortController().signal);
  const operations = await Promise.all([workspace.openOperation(new AbortController().signal), workspace.openOperation(new AbortController().signal)]);
  for (const operation of operations) await operation.validateRoots();
  fail = true;
  await assert.rejects(runtime.close(), /synthetic process cleanup failure/);
  await Promise.all(processes);
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ joined: processes.length, injected }));
});
