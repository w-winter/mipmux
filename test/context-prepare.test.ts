import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { MipmuxRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { contextRequestValidator, type ContextPrepareRequest } from '../src/contracts/context.js';
import { gitValidator } from '../src/contracts/git.js';
import { selectionValidator } from '../src/contracts/selection.js';
import { loadVerifiedBundle, type VerifiedBundle } from '../src/context/verify.js';
import { sha256 } from '../src/workspace/values.js';

const signal = () => new AbortController().signal;
const git = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const nativeExecutable = resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`);
const discoveryTask = 'Discovery draft prompt';
const finalTask = 'Final review task.\r\nLiteral <user_instructions> & λ 🙂';
const workspaceReply = Compile(Type.Object({ id: Type.String() }));
const readyReply = Compile(Type.Object({ kind: Type.Literal('ready'), directory: Type.String(),
  context: Type.Object({ path: Type.String(), byteCount: Type.Integer(), sha256: Type.String() }),
  accounting: Type.Object({ units: Type.Integer(), allowance: Type.Integer() }),
  materials: Type.Array(Type.Object({ kind: Type.String(), id: Type.Optional(Type.String()) })), omitted: Type.Array(Type.Unknown()) }));
const errorReply = Compile(Type.Object({ kind: Type.Literal('error'), code: Type.String() }, { additionalProperties: true }));
const instructions = (prompt: string) => '<user_instructions>\n' + prompt + '\n</user_instructions>\n';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-context-prepare-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  const files = { 'Full.swift': 'struct Full { let value: Map }\n', 'Slice.txt': 'first\nsecond\nthird\n',
    'Map.swift': 'struct Map { let value: Int }\n', 'plan.md': '# Plan\n\nKeep every evidence kind.\n' };
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  run(['add', '.']); run(['commit', '-qm', 'base']);
  await writeFile(join(root, 'Full.swift'), files['Full.swift'] + '// reviewed change\n');
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, nativeExecutable,
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, git: { executable: git } };
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out };
  return { base, root, out, options, spec };
}

/** Publishes a review bundle with every saved material kind and a Diff Follow-Up bundle carrying captured automatic Git. */
async function saveBundles(f: Awaited<ReturnType<typeof fixture>>) {
  const runtime = new MipmuxRuntime(f.options);
  try {
    const workspace = await runtime.declare(f.spec, signal());
    const common = { task: discoveryTask, constraints: 'Keep the constraint.', enhancementMode: 'preserve', purpose: 'review',
      duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, requiredSources: [], patches: [], documents: [] };
    const review = await workspace.createDraft(contextRequestValidator.Parse({ ...common, copyPreset: 'codeReview', outputName: 'review',
      initialSelection: { codemapMode: 'manual', sources: [
        { kind: 'full', source: { root: 'r', path: 'Full.swift' } },
        { kind: 'slices', source: { root: 'r', path: 'Slice.txt' }, ranges: [{ start: 2, end: 2, description: 'Middle line' }] },
        { kind: 'codemap', source: { root: 'r', path: 'Map.swift' } },
      ] },
      documents: [{ kind: 'localDocument', id: 'plan', role: 'plan', source: { root: 'r', path: 'plan.md' } },
        { kind: 'suppliedDocument', id: 'ledger', role: 'evidence', origin: 'fixture', text: 'PRIOR FINDING LEDGER\n' }],
      patches: [{ kind: 'localPatch', id: 'review', root: 'r', comparison: { kind: 'worktree', base: { kind: 'commit', ref: 'HEAD' }, includeUntracked: false },
        scope: { kind: 'all' } }],
    }), signal());
    const diff = gitValidator.Parse(gitValidator.Default({ op: 'diff', maxOutputBytes: 100000 })); assert(diff.op === 'diff');
    const published = await review.publishGitSnapshot(diff, { mode: 'standard', scope: 'all', snapshotID: 'first',
      inlineMap: true, inlineMode: 'brief', inlineMaxLines: 120 }, signal());
    assert(published.kind === 'single');
    await review.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'add', maxOutputBytes: 100000,
      paths: [...published.projection.primarySelectionAliases], strict: true })), signal());
    const reviewReady = await review.finalize(signal());
    assert.equal(reviewReady.kind, 'ready', JSON.stringify(reviewReady.kind === 'blocked' ? reviewReady.diagnostics : null));
    const followUp = await workspace.createDraft(contextRequestValidator.Parse({ ...common, copyPreset: 'diffFollowUp', outputName: 'follow-up',
      initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'r', path: 'Full.swift' } }] } }), signal());
    const planning = await workspace.createDraft(contextRequestValidator.Parse({ ...common, copyPreset: 'standard', purpose: 'planning',
      outputName: 'planning', documents: [{ kind: 'localDocument', id: 'plan', role: 'plan', source: { root: 'r', path: 'plan.md' } }],
      initialSelection: { codemapMode: 'automatic', sources: [{ kind: 'full', source: { root: 'r', path: 'Full.swift' } },
        { kind: 'slices', source: { root: 'r', path: 'Slice.txt' }, ranges: [{ start: 2, end: 2, description: 'Middle line' }] }] } }), signal());
    const planningReady = await planning.finalize(signal());
    assert.equal(planningReady.kind, 'ready', JSON.stringify(planningReady.kind === 'blocked' ? planningReady.diagnostics : null));
    const followUpReady = await followUp.finalize(signal());
    assert.equal(followUpReady.kind, 'ready', JSON.stringify(followUpReady.kind === 'blocked' ? followUpReady.diagnostics : null));
  } finally { await runtime.close(); }
}

async function fileHashes(directory: string) {
  return Promise.all(['manifest.json', 'context.md', 'handoff.md'].map(async name => sha256(await readFile(join(directory, name)))));
}

function evidence(bundle: VerifiedBundle) {
  return { materials: bundle.materials.map(({ record, bodies }) => ({ record: { ...record, frame: null }, bodies })),
    fileTree: bundle.fileTree, automaticGit: bundle.automaticGit,
    request: { ...bundle.verified.manifest.request, outputName: null }, automaticCodemaps: bundle.verified.manifest.automaticCodemaps,
    clipboardPreset: bundle.verified.manifest.clipboardPreset, unavailableFiles: bundle.verified.manifest.unavailableFiles };
}

test('MCP context_prepare reuses or rebuilds saved evidence with a replacement prompt and refuses changed or foreign bundles', async () => {
  const f = await fixture();
  await saveBundles(f);
  const config = join(f.base, 'host.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: f.options.cachePath, contextBudgetUnits: 200000,
    nativeExecutable, nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, git: { executable: git },
    discovery: null, defaultMaxOutputBytes: 100000 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'context-prepare', version: '1' });
  const runtime = new MipmuxRuntime({ ...f.options, cachePath: join(f.base, 'verification-cache') });
  const proof = { prepared: new Map<string, { receipt: unknown; materialKinds: string[]; automaticGit: boolean }>(), symlinkCode: '' };
  try {
    await client.connect(transport);
    const declare = async (spec: typeof f.spec) => workspaceReply.Parse((await client.callTool({ name: 'workspace_declare',
      arguments: { spec } })).structuredContent).id;
    const workspaceId = await declare(f.spec);
    const prepare = (args: ContextPrepareRequest, id = workspaceId) =>
      client.callTool({ name: 'context_prepare', arguments: { workspaceId: id, ...args } });

    for (const [bundle, outputName] of [['review', 'review-task'], ['follow-up', 'follow-up-task']] as const) {
      const savedHashes = await fileHashes(join(f.out, bundle));
      const reply = await prepare({ bundle, prompt: finalTask, outputName });
      assert.equal(reply.isError, false, JSON.stringify(reply));
      const receipt = readyReply.Parse(reply.structuredContent);
      assert.equal(receipt.directory, join(f.out, outputName));
      const saved = await loadVerifiedBundle(join(f.out, bundle)), prepared = await loadVerifiedBundle(receipt.directory);
      assert.deepEqual(evidence(prepared), evidence(saved));
      assert.equal(prepared.verified.manifest.request.outputName, outputName);
      assert.equal(prepared.verified.manifest.prompt, finalTask);
      const before = await readFile(join(f.out, bundle, 'context.md'), 'utf8'), after = await readFile(receipt.context.path, 'utf8');
      assert.equal(before.split(instructions(discoveryTask)).length, 2);
      assert.equal(after, before.replace(instructions(discoveryTask), instructions(finalTask)));
      assert.equal(receipt.accounting.allowance, 200000);
      await verifyBundle(receipt.directory); await verifyCurrentBundle(receipt.directory, runtime, signal());
      assert.deepEqual(await fileHashes(join(f.out, bundle)), savedHashes);
      proof.prepared.set(bundle, { receipt, materialKinds: prepared.verified.manifest.materials.map(material => material.kind),
        automaticGit: prepared.verified.manifest.automaticGit !== null });
    }
    assert.deepEqual([...new Set(proof.prepared.get('review')?.materialKinds)].sort(), ['document', 'gitMap', 'gitPatch', 'patch', 'source']);
    assert.equal(proof.prepared.get('follow-up')?.automaticGit, true);

    const blocked = await prepare({ bundle: 'review', prompt: 'x'.repeat(1_000_000), outputName: 'too-large' });
    assert.equal(blocked.isError, false, JSON.stringify(blocked).slice(0, 2000));
    const blockedReply = Compile(Type.Object({ kind: Type.Literal('blocked'), diagnostics: Type.Array(Type.Object({ code: Type.String() },
      { additionalProperties: true })) }, { additionalProperties: true })).Parse(blocked.structuredContent);
    assert.deepEqual(blockedReply.diagnostics.map(diagnostic => diagnostic.code), ['overBudget']);
    assert.equal(existsSync(join(f.out, 'too-large')), false);

    await symlink(join(f.out, 'review'), join(f.out, 'linked'));
    const linked = await prepare({ bundle: 'linked', prompt: finalTask, outputName: 'via-link' });
    assert.equal(linked.isError, true); proof.symlinkCode = errorReply.Parse(linked.structuredContent).code;
    assert.equal(existsSync(join(f.out, 'via-link')), false);

    const extra = join(f.base, 'extra'); await mkdir(extra);
    const foreign = await declare({ ...f.spec, roots: [...f.spec.roots, { name: 'extra', absolutePath: extra }] });
    const mismatched = await prepare({ bundle: 'review', prompt: finalTask, outputName: 'foreign' }, foreign);
    assert.equal(errorReply.Parse(mismatched.structuredContent).code, 'bundleWorkspaceMismatch');
    assert.equal(existsSync(join(f.out, 'foreign')), false);

    const lateLedger = [{ kind: 'suppliedDocument' as const, id: 'late-ledger', role: 'evidence' as const, origin: 'fixture', text: 'LATE LEDGER\n' }];
    const reviewAdded = readyReply.Parse((await prepare({ bundle: 'review', prompt: finalTask, outputName: 'review-added',
      documents: lateLedger, patches: [{ kind: 'localPatch', id: 'full-swift', root: 'r', scope: { kind: 'paths', paths: ['Full.swift'] },
        comparison: { kind: 'worktree', base: { kind: 'commit', ref: 'HEAD' }, includeUntracked: false } }] })).structuredContent);
    const gitEvidence = (bundle: VerifiedBundle) => bundle.materials.flatMap(({ record, bodies }) =>
      record.kind === 'gitMap' || record.kind === 'gitPatch' ? [{ record: { ...record, frame: null }, bodies }] : []);
    const savedReview = gitEvidence(await loadVerifiedBundle(join(f.out, 'review')));
    assert.equal(savedReview.length, 2);
    assert.deepEqual(gitEvidence(await loadVerifiedBundle(reviewAdded.directory)), savedReview);
    assert(reviewAdded.materials.some(material => material.kind === 'document' && material.id === 'late-ledger'));
    assert(reviewAdded.materials.some(material => material.kind === 'patch' && material.id === 'full-swift'));
    await verifyCurrentBundle(reviewAdded.directory, runtime, signal());

    await writeFile(join(f.root, 'Slice.txt'), 'first\nchanged\nthird\n');
    const changed = await prepare({ bundle: 'review', prompt: finalTask, outputName: 'stale' });
    assert.deepEqual(changed.structuredContent, { kind: 'error', code: 'sourceChanged', source: { root: 'r', path: 'Slice.txt' } });
    assert.equal(existsSync(join(f.out, 'stale')), false);

    const refreshed = readyReply.Parse((await prepare({ bundle: 'planning', prompt: finalTask, outputName: 'planning-refreshed',
      refresh: true })).structuredContent);
    const refreshedContext = await readFile(refreshed.context.path, 'utf8');
    assert(refreshedContext.includes('changed\n') && refreshedContext.endsWith(instructions(finalTask)));
    await verifyCurrentBundle(refreshed.directory, runtime, signal());
    const materialIds = async (directory: string) => (await loadVerifiedBundle(directory)).verified.manifest.materials.map(material => material.id).sort();
    assert.deepEqual(await materialIds(refreshed.directory), await materialIds(join(f.out, 'planning')));
    const added = readyReply.Parse((await prepare({ bundle: 'planning', prompt: finalTask, outputName: 'planning-added',
      documents: [{ kind: 'suppliedDocument', id: 'addendum', role: 'report', origin: 'fixture', text: 'ADDED REPORT\n' }] })).structuredContent);
    assert(added.materials.some(material => material.kind === 'document' && material.id === 'addendum'));
    const staleAddition = await prepare({ bundle: 'review', prompt: finalTask, outputName: 'review-added-stale', documents: lateLedger });
    assert.deepEqual(staleAddition.structuredContent, { kind: 'error', code: 'sourceChanged', source: { root: 'r', path: 'Slice.txt' } });
    assert.equal(existsSync(join(f.out, 'review-added-stale')), false);
    const refused = await prepare({ bundle: 'review', prompt: finalTask, outputName: 'review-refreshed', refresh: true });
    assert.equal(errorReply.Parse(refused.structuredContent).code, 'refreshRequiresDiscovery');
    assert.equal(existsSync(join(f.out, 'review-refreshed')), false);
    await writeFile('test-output/context-prepare.json', JSON.stringify({ prepared: Object.fromEntries(proof.prepared),
      symlinkCode: proof.symlinkCode }, null, 2) + '\n');
  } finally { await client.close(); await runtime.close(); }
});
