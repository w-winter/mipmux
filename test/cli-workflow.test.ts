import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import { verifyBundle } from '../src/index.js';

async function cli(args: string[]) {
  return new Promise<{ code: number; out: string; err: string }>(resolve => {
    execFile(process.execPath, [resolveCommand, ...args], { cwd: '/', maxBuffer: 10 * 1024 * 1024 }, (error, out, err) => {
      resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, out, err });
    });
  });
}
const resolveCommand = resolve('dist/cli/main.js');
test('built CLI warms, explores, renders, verifies, invalidates and emits failed/blocked builder receipts', async () => {
  const provider = await scriptedProvider(() => ({ kind: 'text', text: 'No committed handoff', stop: 'end_turn', tokens: 10 }));
  const directory = provider.directory, root = join(directory, 'root'), out = join(directory, 'out');
  await mkdir(root); await mkdir(out); await writeFile(join(root, 'model.swift'), 'struct Example {\n let name: String\n}\n');
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out };
  const request = { task: 'Caller task', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', purpose: 'planning', requiredSources: [{ kind: 'full', source: { root: 'r', path: 'model.swift' } }],
    documents: [], patches: [], discoveryHints: [], outputName: 'packet' };
  const config = { copyContext: copyContext(), cachePath: join(directory, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, contextBudgetUnits: 100000, defaultEnhancementMode: 'augment', credentialPaths: [], terminationGraceMs: 100, defaultMaxOutputBytes: 10000, git: null, discovery: provider.config };
  const files = { config: join(directory, 'config.json'), spec: join(directory, 'spec.json'), input: join(directory, 'input.json'),
    request: join(directory, 'request.json'), draft: join(directory, 'draft.json'), build: join(directory, 'build.json') };
  await writeFile(files.config, JSON.stringify(config)); await writeFile(files.spec, JSON.stringify(spec));
  await writeFile(files.input, JSON.stringify({ root: 'r', path: 'model.swift', start_line: null, offset: null, limit: null, continuation: null, maxOutputBytes: 10000 }));
  await writeFile(files.request, JSON.stringify({ workspace: spec, request }));
  await writeFile(files.draft, JSON.stringify({ selections: [], prompt: JSON.stringify({ clarifiedTask: 'Task', architecture: 'Model', relationships: [], ambiguities: [] }) }));
  await writeFile(files.build, JSON.stringify({ workspace: spec, request: { ...request, outputName: 'builder',
    budgetUnits: 1 }, requestId: 'one' }));
  try {
    const warm = await cli(['workspace', '--spec', files.spec, '--config', files.config]);
    assert.equal(warm.code, 0, warm.out);
    const inventory = JSON.parse(warm.out), key = inventory.entries.find((entry: { kind: string }) => entry.kind === 'file').structural.key.digest;
    assert.equal((await cli(['tool', 'read_file', '--workspace', files.spec, '--input', files.input, '--config', files.config])).code, 0);
    await writeFile(files.input, JSON.stringify({ type: 'files', mode: 'auto', scope: null, selection: null, maxDepth: null, continuation: null, maxOutputBytes: 10000 }));
    assert.equal((await cli(['tool', 'get_file_tree', '--workspace', files.spec, '--input', files.input, '--config', files.config])).code, 0);
    await writeFile(files.input, JSON.stringify({ type: 'files', mode: 'auto', scope: null, selection: null, maxDepth: null, continuation: null, maxOutputBytes: 1 }));
    assert.equal((await cli(['tool', 'get_file_tree', '--workspace', files.spec, '--input', files.input, '--config', files.config])).code, 1);
    const rendered = await cli(['render', '--request', files.request, '--draft', files.draft, '--config', files.config]);
    assert.equal(rendered.code, 0, rendered.out);
    const result = JSON.parse(rendered.out), bundle = result.directory;
    assert.equal(result.manifest.request.enhancementMode, 'augment');
    assert.equal(result.manifest.request.budgetUnits, config.contextBudgetUnits);
    await verifyBundle(bundle);
    await promisify(execFile)(process.execPath, ['--experimental-loader', resolve('test/fixtures/reject-transport-imports.mjs'),
      resolveCommand, 'verify', '--bundle', bundle, '--mode', 'integrity'], { cwd: '/', maxBuffer: 10 * 1024 * 1024 });
    await promisify(execFile)(process.execPath, ['--experimental-loader', resolve('test/fixtures/reject-transport-imports.mjs'),
      '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(resolve('dist/index.js')).href)});`], { cwd: '/' });
    assert.equal((await cli(['verify', '--bundle', bundle, '--mode', 'integrity'])).code, 0);
    assert.equal((await cli(['verify', '--bundle', bundle, '--mode', 'current', '--config', files.config])).code, 0);
    const artifactPath = join(directory, 'cache/v1/artifacts', key.slice(0, 2), key + '.json');
    await writeFile(artifactPath, '{}');
    const corrupt = await cli(['workspace', '--spec', files.spec, '--config', files.config]);
    assert.deepEqual(JSON.parse(corrupt.out), { kind: 'failed', code: 'cacheCorrupt', target: { kind: 'artifact', key } });
    assert.equal((await cli(['cache', 'invalidate', '--kind', 'artifact', '--key', key, '--config', files.config])).code, 0);
    assert.equal((await cli(['workspace', '--spec', files.spec, '--config', files.config])).code, 0);
    const blocked = await cli(['build', '--request', files.build, '--config', files.config]);
    assert.equal(blocked.code, 2, blocked.out);
    const receipt = JSON.parse(blocked.out);
    assert.equal(receipt.state, 'blocked'); assert.equal(receipt.discovery.workerClosed, true);
    await writeFile(join(directory, 'blocked-receipt.json'), blocked.out);
    await writeFile(files.config, JSON.stringify({ ...config, discovery: { ...provider.config, model: 'not-a-model' } }));
    const failed = await cli(['build', '--request', files.build, '--config', files.config]);
    assert.equal(failed.code, 1, failed.out); assert.equal(JSON.parse(failed.out).state, 'failed');
    assert.equal(JSON.parse(failed.out).discovery.prompt, 'rejected');
    await writeFile(files.config, JSON.stringify({ ...config, nativeExecutable: '/unavailable/native' }));
    const invalidTool = await cli(['tool', 'not-a-tool', '--workspace', files.spec, '--input', files.input, '--config', files.config]);
    assert.equal(JSON.parse(invalidTool.out).code, 'invalidRequest');
    assert(!invalidTool.err.includes('processSpawned'));
  } finally { await provider.close(); }
});

test('CLI build interruption returns a settled cancelled receipt and exit 130', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const provider = await scriptedProvider(() => ({ kind: 'hold', entered }));
  const directory = provider.directory, root = join(directory, 'root'), output = join(directory, 'out');
  await mkdir(root); await mkdir(output);
  const config = join(directory, 'config.json'), request = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(directory, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, contextBudgetUnits: 1000000, credentialPaths: [], terminationGraceMs: 100, defaultMaxOutputBytes: 10000, git: null, discovery: provider.config }));
  await writeFile(request, JSON.stringify({ workspace: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, requestId: 'one',
    request: { task: 'Task', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation', requiredSources: [], documents: [], patches: [], discoveryHints: [],
      outputName: 'packet', budgetUnits: 10000 } }));
  const child = spawn(process.execPath, [resolveCommand, 'build', '--request', request, '--config', config], { cwd: '/', stdio: 'pipe' });
  const stdout: Buffer[] = []; child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.resume();
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  try {
    await started; child.kill('SIGINT');
    assert.equal(await closed, 130);
    const receipt = JSON.parse(Buffer.concat(stdout).toString());
    assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.discovery.workerClosed, true);
    assert.equal(receipt.localSettled, true);
    await writeFile(join(directory, 'cancelled-receipt.json'), Buffer.concat(stdout));
  } finally { child.kill('SIGKILL'); await closed; await provider.close(); }
});
