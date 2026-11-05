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
import { contextRequestValidator } from '../src/contracts/context.js';
import type { CallerDocument, CallerPrepareRequest } from '../src/contracts/caller-context.js';
import { gitValidator } from '../src/contracts/git.js';
import { selectionValidator } from '../src/contracts/selection.js';
import { loadVerifiedBundle, type VerifiedBundle } from '../src/context/verify.js';
import { sha256 } from '../src/workspace/values.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import { toolJSON } from './fixtures/tool-json.js';

const signal = () => new AbortController().signal;
const git = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const nativeExecutable = resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`);
const discoveryTask = 'Discovery draft prompt';
const finalTask = 'Final review task.\r\nLiteral <user_instructions> & λ 🙂';
const readyReply = Compile(Type.Object({ kind: Type.Literal('ready'), directory: Type.String(),
  context: Type.Object({ path: Type.String(), byteCount: Type.Integer(), sha256: Type.String() }),
  accounting: Type.Object({ units: Type.Integer(), allowance: Type.Integer() }),
  added: Type.Array(Type.Object({ kind: Type.String(), id: Type.Optional(Type.String()), path: Type.Optional(Type.String()) })),
  removed: Type.Array(Type.Object({ kind: Type.String(), id: Type.Optional(Type.String()), path: Type.Optional(Type.String()) })),
  omitted: Type.Array(Type.Unknown()) }));
type Change = { kind: string; id?: string; path?: string };
const changes = (receipt: { added: Change[]; removed: Change[] }) =>
  [receipt.added, receipt.removed].map(entries => entries.map(entry => entry.kind + ':' + (entry.id ?? entry.path ?? '')).sort());
const blockedReply = Compile(Type.Object({ kind: Type.Literal('blocked'), diagnostics: Type.Array(Type.Object({ code: Type.String() },
  { additionalProperties: true })) }, { additionalProperties: true }));
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
  // The library runtime that saves bundles and the MCP server that prepares them read the same user Git configuration, so
  // their policies record the same exclude files.
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, nativeExecutable,
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100,
    git: { executable: git, userConfiguration: { home: base, xdgConfigHome: null } } };
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

test('MCP context_prepare retains documents added during discovery when adding another document', async t => {
  const discovered = { id: 'sdk-contract', role: 'evidence', origin: 'discovery', text: 'COMPLETE SDK CONTRACT\n' } satisfies CallerDocument;
  const original = { id: 'ticket', role: 'evidence', origin: 'caller', text: 'ORIGINAL TICKET\n' } satisfies CallerDocument;
  const validation = { id: 'validation', role: 'report', origin: 'coordinator', text: 'VALIDATION RESULTS\n' } satisfies CallerDocument;
  const provider = await scriptedProvider((_summary, index) => index === 1
    ? { kind: 'tool', name: 'draft_update', input: { expectedRevision: 0, maxOutputBytes: 10000,
      mutation: { kind: 'addDocument', document: { kind: 'suppliedDocument', ...discovered } } }, stop: 'tool_use', tokens: 10 }
    : { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 });
  t.after(() => provider.close());
  const f = await fixture(), config = join(f.base, 'host.json');
  await writeFile(config, JSON.stringify({ ...f.options, discovery: provider.config, defaultMaxOutputBytes: 100000 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'context-prepare-documents', version: '1' });
  try {
    await client.connect(transport);
    const job = Compile(Type.Object({ jobId: Type.String() })).Parse(toolJSON(await client.callTool({ name: 'context_builder',
      arguments: { workspace: f.spec, purpose: 'investigation', task: discoveryTask, outputName: 'discovery',
        required: [{ root: 'r', path: 'Full.swift' }], documents: [original] } })));
    const built = Compile(Type.Object({ state: Type.Literal('ready'), bundle: Type.Object({ directory: Type.String() }) }))
      .Parse(toolJSON(await client.callTool({ name: 'context_job', arguments: { op: 'wait', jobId: job.jobId, durationMs: 10000 } })));
    const before = await readFile(join(built.bundle.directory, 'context.md'), 'utf8');
    assert(before.includes(discovered.text));
    const receipt = readyReply.Parse(toolJSON(await client.callTool({ name: 'context_prepare', arguments: {
      workspace: f.spec, bundle: 'discovery', prompt: finalTask, outputName: 'prepared', documents: [validation],
    } })));
    assert.deepEqual(changes(receipt), [['document:validation'], []]);
    const packet = await readFile(receipt.context.path, 'utf8');
    for (const document of [original, discovered, validation]) assert(packet.includes(document.text), document.id);
    await verifyBundle(receipt.directory);
    await writeFile('test-output/context-prepare-documents.json', JSON.stringify(receipt, null, 2) + '\n');
  } finally { await client.close(); }
});

test('MCP context_prepare reuses or rebuilds saved evidence with a replacement prompt and refuses changed or foreign bundles', async () => {
  const f = await fixture();
  await saveBundles(f);
  const config = join(f.base, 'host.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: f.options.cachePath, contextBudgetUnits: 200000,
    nativeExecutable, nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, git: f.options.git,
    discovery: null, defaultMaxOutputBytes: 100000 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'context-prepare', version: '1' });
  const runtime = new MipmuxRuntime({ ...f.options, cachePath: join(f.base, 'verification-cache') });
  const proof = { prepared: new Map<string, { receipt: unknown; materialKinds: string[]; automaticGit: boolean }>(), symlinkCode: '' };
  try {
    await client.connect(transport);
    const prepare = (args: Omit<CallerPrepareRequest, 'workspace'>, workspace: typeof f.spec = f.spec) =>
      client.callTool({ name: 'context_prepare', arguments: { workspace, ...args } });

    for (const [bundle, outputName] of [['review', 'review-task'], ['follow-up', 'follow-up-task']] as const) {
      const savedHashes = await fileHashes(join(f.out, bundle));
      const reply = await prepare({ bundle, prompt: finalTask, outputName });
      assert.equal(reply.isError, false, JSON.stringify(reply));
      const receipt = readyReply.Parse(toolJSON(reply));
      assert.equal(receipt.directory, join(f.out, outputName));
      assert.deepEqual(changes(receipt), [[], []]);
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

    // Replacing only the task is not limited by the saved budget: the allowance rises to fit and the bundle still verifies.
    const longTask = await prepare({ bundle: 'review', prompt: 'x'.repeat(1_000_000), outputName: 'long-task' });
    assert.equal(longTask.isError, false, JSON.stringify(longTask).slice(0, 2000));
    const longReceipt = readyReply.Parse(toolJSON(longTask));
    assert(longReceipt.accounting.units > 200000, String(longReceipt.accounting.units));
    assert.equal(longReceipt.accounting.allowance, longReceipt.accounting.units);
    await verifyBundle(longReceipt.directory); await verifyCurrentBundle(longReceipt.directory, runtime, signal());

    await symlink(join(f.out, 'review'), join(f.out, 'linked'));
    const linked = await prepare({ bundle: 'linked', prompt: finalTask, outputName: 'via-link' });
    assert.equal(linked.isError, true); proof.symlinkCode = errorReply.Parse(toolJSON(linked)).code;
    assert.equal(existsSync(join(f.out, 'via-link')), false);

    const extra = join(f.base, 'extra'); await mkdir(extra);
    const foreign = { ...f.spec, roots: [...f.spec.roots, { name: 'extra', absolutePath: extra }] };
    const mismatched = await prepare({ bundle: 'review', prompt: finalTask, outputName: 'foreign' }, foreign);
    assert.equal(errorReply.Parse(toolJSON(mismatched)).code, 'bundleWorkspaceMismatch');
    assert.equal(existsSync(join(f.out, 'foreign')), false);

    const lateLedger = [{ id: 'late-ledger', role: 'evidence', origin: 'fixture', text: 'LATE LEDGER\n' }] satisfies CallerDocument[];
    const reviewAdded = readyReply.Parse(toolJSON(await prepare({ bundle: 'review', prompt: finalTask, outputName: 'review-added',
      documents: lateLedger, patches: [{ id: 'full-swift', root: 'r', paths: ['Full.swift'],
        comparison: { kind: 'worktree', base: 'HEAD', includeUntracked: false } }] })));
    const gitEvidence = (bundle: VerifiedBundle) => bundle.materials.flatMap(({ record, bodies }) =>
      record.kind === 'gitMap' || record.kind === 'gitPatch' ? [{ record: { ...record, frame: null }, bodies }] : []);
    const savedReview = gitEvidence(await loadVerifiedBundle(join(f.out, 'review')));
    assert.equal(savedReview.length, 2);
    assert.deepEqual(gitEvidence(await loadVerifiedBundle(reviewAdded.directory)), savedReview);
    assert.deepEqual(changes(reviewAdded), [['document:late-ledger', 'patch:full-swift'], []]);
    await verifyCurrentBundle(reviewAdded.directory, runtime, signal());

    // An explicit budget applies to reused evidence: a small one blocks publication, and a larger one is recorded.
    const smallBudget = await prepare({ bundle: 'review', prompt: finalTask, outputName: 'review-small', budgetUnits: 100 });
    assert.deepEqual(blockedReply.Parse(toolJSON(smallBudget)).diagnostics.map(diagnostic => diagnostic.code), ['overBudget']);
    assert.equal(existsSync(join(f.out, 'review-small')), false);
    const largeBudget = readyReply.Parse(toolJSON(await prepare({ bundle: 'review', prompt: finalTask, outputName: 'review-large',
      budgetUnits: 300000 })));
    assert.equal(largeBudget.accounting.allowance, 300000);
    await verifyBundle(largeBudget.directory); await verifyCurrentBundle(largeBudget.directory, runtime, signal());

    // Removing one saved Git artifact by its alias leaves the other byte-identical.
    const mapAlias = savedReview.flatMap(({ record }) => record.kind === 'gitMap' ? [record.reference.alias] : [])[0]!;
    const withoutMap = readyReply.Parse(toolJSON(await prepare({ bundle: 'review', prompt: finalTask, outputName: 'review-without-map',
      remove: [mapAlias] })));
    assert.deepEqual(changes(withoutMap), [[], ['gitMap:' + mapAlias]]);
    assert.deepEqual(gitEvidence(await loadVerifiedBundle(withoutMap.directory)), savedReview.filter(({ record }) => record.kind === 'gitPatch'));
    await verifyCurrentBundle(withoutMap.directory, runtime, signal());

    await writeFile(join(f.root, 'Slice.txt'), 'first\nchanged\nthird\n');
    const changed = await prepare({ bundle: 'review', prompt: finalTask, outputName: 'stale' });
    assert.deepEqual(toolJSON(changed), { kind: 'error', code: 'sourceChanged', source: { root: 'r', path: 'Slice.txt' } });
    assert.equal(existsSync(join(f.out, 'stale')), false);

    const refreshed = readyReply.Parse(toolJSON(await prepare({ bundle: 'planning', prompt: finalTask, outputName: 'planning-refreshed',
      refresh: true })));
    assert.deepEqual(changes(refreshed), [[], []]);
    const refreshedContext = await readFile(refreshed.context.path, 'utf8');
    assert(refreshedContext.includes('changed\n') && refreshedContext.endsWith(instructions(finalTask)));
    await verifyCurrentBundle(refreshed.directory, runtime, signal());
    const materialIds = async (directory: string) => (await loadVerifiedBundle(directory)).verified.manifest.materials.map(material => material.id).sort();
    assert.deepEqual(await materialIds(refreshed.directory), await materialIds(join(f.out, 'planning')));
    const added = readyReply.Parse(toolJSON(await prepare({ bundle: 'planning', prompt: finalTask, outputName: 'planning-added',
      documents: [{ id: 'addendum', role: 'report', origin: 'fixture', text: 'ADDED REPORT\n' }] })));
    assert.deepEqual(changes(added), [['document:addendum'], []]);

    // Removal and demotion name materials by their receipt paths and rebuild from current files.
    const trimmed = readyReply.Parse(toolJSON(await prepare({ bundle: 'planning', prompt: finalTask, outputName: 'planning-trimmed',
      remove: ['r/Slice.txt'] })));
    assert.deepEqual(changes(trimmed), [[], ['slices:r/Slice.txt']]);
    await verifyCurrentBundle(trimmed.directory, runtime, signal());
    const demoted = readyReply.Parse(toolJSON(await prepare({ bundle: 'planning', prompt: finalTask, outputName: 'planning-demoted',
      demote: ['r/Full.swift'], budgetUnits: 250000 })));
    assert.deepEqual(changes(demoted), [['codemap:r/Full.swift'], ['full:r/Full.swift']]);
    assert.equal(demoted.accounting.allowance, 250000);
    await verifyCurrentBundle(demoted.directory, runtime, signal());
    const unknown = await prepare({ bundle: 'planning', prompt: finalTask, outputName: 'planning-unknown', remove: ['r/missing.swift'] });
    const unknownError = Compile(Type.Object({ kind: Type.Literal('error'), code: Type.Literal('invalidSelection'), message: Type.String() }))
      .Parse(toolJSON(unknown));
    assert(unknownError.message.includes('r/missing.swift'), unknownError.message);
    assert.equal(existsSync(join(f.out, 'planning-unknown')), false);
    const required = readyReply.Parse(toolJSON(await prepare({ bundle: 'planning', prompt: finalTask, outputName: 'planning-required',
      required: [{ root: 'r', path: 'Map.swift' }] })));
    assert.deepEqual(changes(required), [['full:r/Map.swift'], []]);
    const requiredRemoval = await prepare({ bundle: 'planning-required', prompt: finalTask, outputName: 'planning-required-removed',
      remove: ['r/Map.swift'] });
    assert.equal(errorReply.Parse(toolJSON(requiredRemoval)).code, 'invalidSelection');
    assert.equal(existsSync(join(f.out, 'planning-required-removed')), false);
    const staleAddition = await prepare({ bundle: 'review', prompt: finalTask, outputName: 'review-added-stale', documents: lateLedger });
    assert.deepEqual(toolJSON(staleAddition), { kind: 'error', code: 'sourceChanged', source: { root: 'r', path: 'Slice.txt' } });
    assert.equal(existsSync(join(f.out, 'review-added-stale')), false);
    const refused = await prepare({ bundle: 'review', prompt: finalTask, outputName: 'review-refreshed', refresh: true });
    assert.equal(errorReply.Parse(toolJSON(refused)).code, 'refreshRequiresDiscovery');
    assert.equal(existsSync(join(f.out, 'review-refreshed')), false);
    await writeFile('test-output/context-prepare.json', JSON.stringify({ prepared: Object.fromEntries(proof.prepared),
      symlinkCode: proof.symlinkCode }, null, 2) + '\n');
  } finally { await client.close(); await runtime.close(); }
});
