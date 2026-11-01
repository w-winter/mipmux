import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { CallerBuildRequest } from '../src/contracts/caller-context.js';
import { copyContext } from './fixtures/copy-context.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import { toolJSON } from './fixtures/tool-json.js';

const snapshot = Compile(Type.Object({ jobId: Type.String(), state: Type.String(), localSettled: Type.Boolean() }));
const ready = Compile(Type.Object({ state: Type.Literal('ready'),
  discovery: Type.Object({ requested: Type.Object({ provider: Type.String(), model: Type.String(), thinking: Type.String() }) }),
  bundle: Type.Object({ accounting: Type.Object({ allowance: Type.Number() }) }) }));
const failure = Compile(Type.Object({ kind: Type.Literal('error'), code: Type.String() }));
/** The discovery settings a test file sets besides the scripted provider's. */
interface DiscoveryOverrides { readonly thinking?: 'low'; readonly allowedModels: readonly string[] }
const models = Compile(Type.Object({ kind: Type.Literal('models'), models: Type.Array(Type.String()) }, { additionalProperties: false }));

test('a running server applies edited request defaults and allowed models at the next build, and mipmux models lists what discovery can reach', async t => {
  const provider = await scriptedProvider(() => ({ kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 }));
  t.after(() => provider.close());
  const root = join(provider.directory, 'root'), out = join(provider.directory, 'out');
  await mkdir(root); await mkdir(out); await writeFile(join(root, 'model.swift'), 'struct Model {}\n');
  const configPath = join(provider.directory, 'config.json');
  const file = (contextBudgetUnits: number, discovery: DiscoveryOverrides) => JSON.stringify({ copyContext: copyContext(),
    cachePath: join(provider.directory, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, terminationGraceMs: 100, contextBudgetUnits, credentialPaths: [], git: null, defaultMaxOutputBytes: 100000,
    discovery: { ...provider.config, ...discovery } }, null, 2);
  await writeFile(configPath, file(200000, { allowedModels: [] }));

  // Discovery's worker sees only discovery.environment, so a key in this process's environment adds no models.
  const listed = models.Parse(JSON.parse((await promisify(execFile)(process.execPath, [resolve('dist/cli/main.js'), 'models', '--config', configPath],
    { env: { ...process.env, OPENAI_API_KEY: 'not-for-discovery' } })).stdout));
  assert(listed.models.includes('anthropic/claude-sonnet-4-5') && listed.models.includes('anthropic/claude-haiku-4-5'), JSON.stringify(listed));
  assert(listed.models.every(model => model.startsWith('anthropic/')), JSON.stringify(listed));
  assert.deepEqual(listed.models, [...listed.models].sort());

  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', configPath],
    cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'config-reload', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const request = { workspace: { roots: [{ name: 'r', absolutePath: root }], outputRoot: out }, purpose: 'investigation',
    task: 'Inspect the model' } satisfies Omit<CallerBuildRequest, 'outputName'>;
  const build = (args: CallerBuildRequest) => client.callTool({ name: 'context_builder', arguments: args });
  const settled = async (args: CallerBuildRequest) => {
    const started = await build(args);
    assert.equal(started.isError, false, JSON.stringify(started));
    const { jobId } = snapshot.Parse(toolJSON(started));
    for (;;) {
      const reply = toolJSON(await client.callTool({ name: 'context_job', arguments: { op: 'wait', jobId, durationMs: 10000 } }));
      if (snapshot.Parse(reply).localSettled) return ready.Parse(reply);
    }
  };
  const haiku = { model: 'anthropic/claude-haiku-4-5' };
  assert.equal(failure.Parse(toolJSON(await build({ ...request, outputName: 'run-1', discovery: haiku }))).code, 'modelNotAllowed');

  await writeFile(configPath, file(150000, { thinking: 'low', allowedModels: ['anthropic/claude-haiku-4-5'] }));
  assert.equal((await settled({ ...request, outputName: 'run-2', discovery: haiku })).discovery.requested.model, 'claude-haiku-4-5');
  const defaults = await settled({ ...request, outputName: 'run-3' });
  assert.deepEqual(defaults.discovery.requested, { provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'low' });
  assert.equal(defaults.bundle.accounting.allowance, 150000);

  // A file that is not valid configuration, as in the middle of an edit, fails the call instead of using stale defaults.
  await writeFile(configPath, '{ "contextBudgetUnits": ');
  assert.equal(failure.Parse(toolJSON(await build({ ...request, outputName: 'run-4' }))).code, 'configurationReadFailed');
});
