import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SmipRuntime, type ContextBuildRequest } from '../src/index.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';

const command = resolve('dist/cli/main.js');
const signal = () => new AbortController().signal;
const terminalKeys = ['jobId', 'sequence', 'requestDigest', 'progress', 'state', 'code', 'target', 'discovery', 'localSettled', 'sharedIndexInterest'];

test('builder terminal receipts retain the sanitized cache recovery target through library, MCP and CLI', async () => {
  const provider = await scriptedProvider(() => ({ kind: 'text', text: 'No committed handoff', stop: 'end_turn', tokens: 10 }));
  const base = provider.directory, root = join(base, 'root'), outputRoot = join(base, 'out'), config = join(base, 'config.json');
  await mkdir(root); await mkdir(outputRoot);
  await writeFile(join(root, 'model.swift'), 'struct Model {\n let title: String\n}');
  const options = { cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [config], nativeEnvironment: {},
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`) };
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot };
  const request: ContextBuildRequest = { task: 'Task', copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation', requiredSources: [], documents: [], patches: [],
    discoveryHints: [], outputName: 'packet', budgetUnits: 100000 };
  await writeFile(config, JSON.stringify({ ...options, search: null, git: null, discovery: provider.config, defaultMaxOutputBytes: 10000 }));
  try { await exercise(); } finally { await provider.close(); }

  async function exercise() {
  const warm = new SmipRuntime(options);
  let key: string, membershipPath: string;
  try {
    const client = warm.createClient(null);
    const workspace = await client.declare(spec, signal());
    const inventory = await client.refresh(workspace.id, signal());
    const entry = inventory.entries.find(entry => entry.kind === 'file');
    if (entry?.kind !== 'file' || entry.structural.kind !== 'artifact') assert.fail('missing artifact');
    key = entry.structural.key.digest;
    membershipPath = join(options.cachePath, 'v1/workspaces', inventory.workspaceKey, 'membership.json');
    await client.close();
  } finally { await warm.close(); }
  const artifactPath = join(options.cachePath, 'v1/artifacts', key.slice(0, 2), key + '.json');
  const target = { kind: 'artifact', key };
  const corrupt = async () => { await writeFile(artifactPath, '{}'); };
  // Explicit invalidation removes only the named artifact; the valid membership record beside it is untouched.
  const invalidate = async (run: () => Promise<unknown>) => {
    const membership = await readFile(membershipPath);
    await run();
    await assert.rejects(access(artifactPath)); assert.deepEqual(await readFile(membershipPath), membership);
  };
  const proof: Record<string, unknown> = {};

  await corrupt();
  const runtime = new SmipRuntime(options);
  try {
    const client = runtime.createClient(new PiRunner(provider.config, runtime.supervisor));
    const workspace = await client.declare(spec, signal());
    const job = client.build(workspace.id, 'one', request);
    const failed = await client.wait(job.jobId, 20000, signal(), () => {});
    assert.equal(failed.state, 'failed');
    if (failed.state !== 'failed') assert.fail('unreachable');
    assert.equal(failed.code, 'cacheCorrupt');
    // The public contract is the serialized receipt; it must carry the validated target.
    const serialized = JSON.parse(JSON.stringify(failed));
    assert.deepEqual(serialized.target, target);
    assert.deepEqual(Object.keys(serialized).sort(), [...terminalKeys].sort());
    assert.deepEqual(client.result(job.jobId), failed);
    await invalidate(() => runtime.artifacts.invalidate(key));
    const reconciled = await client.wait(client.build(workspace.id, 'two', { ...request, outputName: 'two' }).jobId, 20000, signal(), () => {});
    assert.equal(reconciled.state, 'ready');
    proof.library = failed;
    await client.close();
  } finally { await runtime.close(); }

  await corrupt();
  const transport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const mcp = new Client({ name: 'cache-recovery', version: '1' });
  try {
    await mcp.connect(transport);
    const declared = await mcp.callTool({ name: 'workspace_declare', arguments: { spec } });
    const workspaceId = JSON.parse(JSON.stringify(declared.structuredContent)).id;
    const started = await mcp.callTool({ name: 'context_builder', arguments: { workspaceId, requestId: 'one', request } });
    const jobId = JSON.parse(JSON.stringify(started.structuredContent)).jobId;
    const waited = JSON.parse(JSON.stringify((await mcp.callTool({ name: 'context_builder_wait', arguments: { jobId, durationMs: 20000 } })).structuredContent));
    const result = JSON.parse(JSON.stringify((await mcp.callTool({ name: 'context_builder_result', arguments: { jobId } })).structuredContent));
    for (const snapshot of [waited, result]) {
      assert.equal(snapshot.state, 'failed'); assert.equal(snapshot.code, 'cacheCorrupt');
      assert.deepEqual(snapshot.target, target); assert.deepEqual(Object.keys(snapshot).sort(), [...terminalKeys].sort());
    }
    await invalidate(() => promisify(execFile)(process.execPath, [command, 'cache', 'invalidate', '--kind', 'artifact', '--key', key, '--config', config], { cwd: '/' }));
    const second = JSON.parse(JSON.stringify((await mcp.callTool({ name: 'context_builder', arguments: { workspaceId, requestId: 'two', request: { ...request, outputName: 'mcp-two' } } })).structuredContent));
    const reconciled = JSON.parse(JSON.stringify((await mcp.callTool({ name: 'context_builder_wait', arguments: { jobId: second.jobId, durationMs: 20000 } })).structuredContent));
    assert.equal(reconciled.state, 'ready');
    proof.mcp = waited;
  } finally { await mcp.close(); }

  await corrupt();
  const build = join(base, 'build.json');
  await writeFile(build, JSON.stringify({ workspace: spec, request: { ...request, outputName: 'cli' }, requestId: 'one' }));
  const cli = (args: string[]) => new Promise<{ code: number; out: string }>(done => {
    execFile(process.execPath, [command, ...args], { cwd: '/', maxBuffer: 10 * 1024 * 1024 }, (error, out) => {
      done({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, out });
    });
  });
  const failed = await cli(['build', '--request', build, '--config', config]);
  assert.equal(failed.code, 1, failed.out);
  const receipt = JSON.parse(failed.out);
  assert.equal(receipt.state, 'failed'); assert.equal(receipt.code, 'cacheCorrupt');
  assert.deepEqual(receipt.target, target); assert.deepEqual(Object.keys(receipt).sort(), [...terminalKeys].sort());
  await invalidate(async () => assert.equal((await cli(['cache', 'invalidate', '--kind', 'artifact', '--key', key, '--config', config])).code, 0));
  await writeFile(build, JSON.stringify({ workspace: spec, request: { ...request, outputName: 'cli-two' }, requestId: 'two' }));
  const reconciled = await cli(['build', '--request', build, '--config', config]);
  assert.equal(reconciled.code, 0, reconciled.out);
  assert.equal(JSON.parse(reconciled.out).state, 'ready');
  proof.cli = receipt;
  await writeFile(join(base, 'cache-recovery-proof.json'), JSON.stringify(proof) + '\n');
  }
});
