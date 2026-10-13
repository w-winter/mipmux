import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';

const review = { id: 'd7f1b2e4-3c5a-6b8d-cf8e-1f5d0e2a4c6b', title: 'Operator review "<&>', content: 'Complete selected role\n🙂\n' };
const unrelated = { id: '8e81aac2-79ce-4897-a59e-efd81eebb7e9', title: 'Other role', content: 'Do not inject this role.' };
for (const [copyPreset, storedPrompts] of [
  ['standard', [unrelated, review]], ['codeReview', [unrelated, review]], ['codeReview', [unrelated]],
] as const) test(`copy preset ${copyPreset} selects only its captured stored prompt from ${storedPrompts.length} entries`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smip-copy-preset-'));
  await mkdir(join(directory, 'root')); await mkdir(join(directory, 'out')); await mkdir('test-output', { recursive: true });
  const runtime = new SmipRuntime({ cachePath: join(directory, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = new AbortController().signal;
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(directory, 'root') }],
      exclusions: [], outputRoot: join(directory, 'out') }, signal);
    const request = { duplicateUserInstructionsAtTop: false, copyPreset, storedPrompts: [...storedPrompts], task: 'Literal task', constraints: 'Explicit constraint',
      enhancementMode: 'preserve' as const, purpose: 'review' as const, requiredSources: [], documents: [], patches: [],
      discoveryHints: [], outputName: 'packet', budgetUnits: 100000 };
    const draft = await workspace.createDraft(request, signal);
    // Admission captures the catalog; later caller mutation must not change the ready packet.
    request.storedPrompts = [];
    const costs = await draft.inspect({ view: 'costs', maxOutputBytes: 30000, continuation: null }, signal);
    assert(costs.kind === 'costs');
    const result = await draft.finalize(signal); assert(result.kind === 'ready');
    const context = await readFile(join(result.directory, 'context.md'), 'utf8');
    const includeReview = copyPreset === 'codeReview' && storedPrompts.some(prompt => prompt.id === review.id);
    const expected = (includeReview ? '<meta prompt 1 = "' + review.title + '">\n' + review.content + '\n</meta prompt 1>\n' : '') +
      '<meta prompt ' + (includeReview ? 2 : 1) + ' = "Constraints">\nExplicit constraint\n</meta prompt ' + (includeReview ? 2 : 1) + '>\n' +
      '<user_instructions>\nLiteral task\n</user_instructions>\n';
    assert.equal(context, expected);
    assert.equal(costs.measurement.bytes, Buffer.byteLength(context));
    await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, runtime, signal);
    await writeFile(`test-output/copy-preset-${copyPreset}-${storedPrompts.length}.json`, JSON.stringify({ directory: result.directory,
      bytes: Buffer.byteLength(context), includesReview: includeReview, manifest: result.manifest }, null, 2) + '\n');
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});
