import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { CallerBuildRequest, CallerJobRequest } from '../src/contracts/caller-context.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import { toolJSON } from './fixtures/tool-json.js';

const snapshotReply = Compile(Type.Object({ jobId: Type.String(), state: Type.String(), localSettled: Type.Boolean() }));
const requestedReply = Compile(Type.Object({ jobId: Type.String(), state: Type.String(), code: Type.Optional(Type.String()),
  discovery: Type.Object({ requested: Type.Object({ provider: Type.String(), model: Type.String(), thinking: Type.String() }),
    thinkingLevels: Type.Union([Type.Array(Type.String()), Type.Null()]) }) }));
const errorReply = Compile(Type.Object({ kind: Type.Literal('error'), code: Type.String(), message: Type.Optional(Type.String()) }));
// The scripted provider's default model, claude-sonnet-5-5, supports these levels and no others.
const sonnetLevels = ['low', 'medium', 'high', 'xhigh', 'max'];

test('a build selects an allowed discovery model and level, fixed for its job and recorded in the receipt', async t => {
  const provider = await scriptedProvider(() => ({ kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 }));
  t.after(() => provider.close());
  const root = join(provider.directory, 'root'), out = join(provider.directory, 'out');
  await mkdir(root); await mkdir(out); await writeFile(join(root, 'model.swift'), 'struct Model {}\n');
  const config = join(provider.directory, 'config.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(provider.directory, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 200000, credentialPaths: [], git: null, defaultMaxOutputBytes: 100000,
    discovery: { ...provider.config, allowedModels: ['anthropic/claude-haiku-4-5'] } }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config],
    cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'discovery-selection', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const build = (args: CallerBuildRequest) => client.callTool({ name: 'context_builder', arguments: args });
  const job = (args: CallerJobRequest) => client.callTool({ name: 'context_job', arguments: args });
  const started = async (args: CallerBuildRequest) => {
    const reply = await build(args);
    assert.equal(reply.isError, false, JSON.stringify(reply));
    return snapshotReply.Parse(toolJSON(reply)).jobId;
  };
  const settle = async (jobId: string) => {
    for (;;) {
      const reply = toolJSON(await job({ op: 'wait', jobId, durationMs: 10000 }));
      if (snapshotReply.Parse(reply).localSettled) return requestedReply.Parse(reply);
    }
  };
  const request = { workspace: { roots: [{ name: 'r', absolutePath: root }], outputRoot: out }, purpose: 'investigation',
    task: 'Inspect the model' } satisfies Omit<CallerBuildRequest, 'outputName'>;

  const refused = await build({ ...request, outputName: 'run-refused', discovery: { model: 'openai/gpt-unlisted' } });
  assert.equal(refused.isError, true);
  const refusal = errorReply.Parse(toolJSON(refused));
  assert.equal(refusal.code, 'modelNotAllowed');
  for (const reference of ['openai/gpt-unlisted', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-4-5']) assert.match(refusal.message ?? '', new RegExp(reference));
  assert.equal(provider.requests.length, 0);

  const selection = { model: 'anthropic/claude-haiku-4-5', thinking: 'low' } as const;
  const selected = await started({ ...request, outputName: 'run-selected', discovery: selection });
  const ready = await settle(selected);
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.discovery.requested, { provider: 'anthropic', model: 'claude-haiku-4-5', thinking: 'low' });
  assert(ready.discovery.thinkingLevels?.includes('low'));
  assert(provider.requests.length > 0 && provider.requests.every(sent => sent.model === 'claude-haiku-4-5'));
  assert.equal(await started({ ...request, outputName: 'run-selected', discovery: selection }), selected);
  const changed = await build({ ...request, outputName: 'run-selected', discovery: { ...selection, thinking: 'medium' } });
  assert.equal(errorReply.Parse(toolJSON(changed)).code, 'outputNameConflict');

  // Omitting the selection and naming the configured defaults resolve to the same settings, so they are the same job.
  const defaults = await started({ ...request, outputName: 'run-default' });
  assert.equal(await started({ ...request, outputName: 'run-default', discovery: { model: 'anthropic/claude-sonnet-5-5', thinking: 'low' } }), defaults);
  assert.deepEqual((await settle(defaults)).discovery.requested, { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'low' });

  const prepared = await client.callTool({ name: 'context_prepare', arguments: { workspace: request.workspace, bundle: 'run-selected',
    prompt: 'Final task', outputName: 'run-selected-final', discovery: selection } });
  assert.equal(prepared.isError, true);

  const requests = provider.requests.length;
  const unsupported = await settle(await started({ ...request, outputName: 'run-minimal', discovery: { thinking: 'minimal' } }));
  assert.equal(unsupported.state, 'failed'); assert.equal(unsupported.code, 'unsupportedThinkingLevel');
  assert.deepEqual(unsupported.discovery.thinkingLevels, sonnetLevels);
  assert.equal(provider.requests.length, requests);
  await writeFile(join(provider.directory, 'discovery-selection-proof.json'), JSON.stringify({ refusal, ready, unsupported }, null, 2) + '\n');
});
