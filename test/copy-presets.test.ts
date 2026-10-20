import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MipmuxRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { contextRequestValidator } from '../src/contracts/context.js';

for (const copyPreset of ['standard', 'codeReview', 'diffFollowUp', 'manual'] as const) test(`copy preset ${copyPreset} publishes a role-free packet with fixed constraints`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mipmux-copy-preset-'));
  await mkdir(join(directory, 'root')); await mkdir(join(directory, 'out')); await mkdir('test-output', { recursive: true });
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(directory, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = new AbortController().signal;
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(directory, 'root') }],
      exclusions: [], outputRoot: join(directory, 'out') }, signal);
    const request = { initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset, task: 'Literal task', constraints: 'Explicit constraint',
      enhancementMode: 'preserve' as const, purpose: 'review' as const, requiredSources: [], documents: [], patches: [],
      discoveryHints: [], outputName: 'packet', budgetUnits: 100000 };
    const draft = await workspace.createDraft(contextRequestValidator.Parse(request), signal);
    request.task = 'Caller mutation';
    request.constraints = 'Caller mutation';
    const costs = await draft.inspect({ view: 'costs', maxOutputBytes: 30000, continuation: null }, signal);
    assert(costs.kind === 'costs');
    const result = await draft.finalize(signal); assert(result.kind === 'ready');
    const context = await readFile(join(result.directory, 'context.md'), 'utf8');
    const expected = '<constraints>\nExplicit constraint\n</constraints>\n' +
      '<user_instructions>\nLiteral task\n</user_instructions>\n';
    assert.equal(context, expected);
    assert.equal(costs.measurement.bytes, Buffer.byteLength(context));
    assert.equal(result.manifest.schemaVersion, 25);
    await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, runtime, signal);
    await writeFile(`test-output/copy-preset-${copyPreset}.json`, JSON.stringify({ directory: result.directory,
      bytes: Buffer.byteLength(context), manifest: result.manifest }, null, 2) + '\n');
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});
