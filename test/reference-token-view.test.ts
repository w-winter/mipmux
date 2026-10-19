import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime, type ContextBuildRequest } from '../src/index.js';
import { ReferenceTokenStats } from '../src/contracts/token-accounting.js';
import { selectionValidator } from '../src/contracts/selection.js';
import { gitValidator } from '../src/contracts/git.js';

const tokens = Compile(Type.Object({ token_stats: ReferenceTokenStats,
  token_accounting: Type.Object({ status: Type.String(), source: Type.String(), refresh_pending: Type.Boolean() }) }));
const signal = () => new AbortController().signal;
const units = (text: string) => Math.floor(Buffer.byteLength(text) * 21 / 80);
const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const architect = { id: '8e81aac2-79ce-4897-a59e-efd81eebb7e9', title: 'Role', content: 'Source-selected role '.repeat(5) };

async function fixture(copyPreset: ContextBuildRequest['copyPreset']) {
  const base = await mkdtemp(join(tmpdir(), 'smip-reference-token-view-'));
  const a = join(base, 'a'), b = join(base, 'b'), out = join(base, 'out');
  await mkdir(a); await mkdir(b); await mkdir(out);
  const full = 'Original selected body '.repeat(5) + '\n', slices = 'one\r\nsecond selected line\r\nthree\n';
  await writeFile(join(a, 'main.txt'), full); await writeFile(join(a, 'slice.txt'), slices);
  await writeFile(join(a, 'Map.swift'), 'struct Map { let property: String }\n');
  await writeFile(join(b, 'proposed-file-with-a-longer-name.txt'), 'Proposed selected body '.repeat(30) + '\n');
  const run = (args: string[]) => execFileSync(git, args, { cwd: a, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  run(['add', '.']); run(['commit', '-qm', 'base']);
  await writeFile(join(a, 'main.txt'), full + 'working tree difference\n');
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, git: { executable: git } });
  const workspace = await runtime.declare({ roots: [{ name: 'Alpha', absolutePath: a }, { name: 'LongerBetaRoot', absolutePath: b }],
    exclusions: [], outputRoot: out }, signal());
  const request: ContextBuildRequest = { task: 'Raw task '.repeat(10), constraints: 'Explicit constraint '.repeat(4),
    initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'Alpha', path: 'main.txt' } }] },
    requiredSources: [], patches: [], documents: [], discoveryHints: [], budgetUnits: 200000, outputName: 'packet',
    enhancementMode: 'preserve', purpose: 'investigation', duplicateUserInstructionsAtTop: true, copyPreset, storedPrompts: [architect] };
  return { base, a, out, full: full + 'working tree difference\n', slices, runtime, workspace, request,
    draft: await workspace.createDraft(request, signal()) };
}

test('reference components count captured representations and raw instructions separately from packet framing', async () => {
  const f = await fixture('plan');
  try {
    await f.draft.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: { kind: 'upsert', selection: {
      kind: 'slices', source: { root: 'Alpha', path: 'slice.txt' }, ranges: [{ start: 2, end: 2, description: 'Selected line' }] } } }, signal());
    await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'add', mode: 'codemap_only',
      paths: ['Alpha/Map.swift'], maxOutputBytes: 100000 })), signal());
    const selected = await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'content', maxOutputBytes: 100000 })), signal());
    const stats = tokens.Parse(selected);
    assert.equal(stats.token_stats.files_content, units(f.full) + units('second selected line\r\n'));
    assert.equal(stats.token_stats.codemaps, selected.summary?.codemap_tokens);
    assert.equal(stats.token_stats.prompt, 2 * units(f.request.task));
    assert.equal(stats.token_stats.meta, units(architect.content + '\n\n' + f.request.constraints));
    assert.equal(stats.token_stats.git, undefined);
    assert.equal(stats.token_accounting.source, 'captured_draft');
    assert.equal(stats.token_accounting.refresh_pending, false);
    const filtered = tokens.Parse(await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'codemaps', maxOutputBytes: 100000 })), signal()));
    assert.deepEqual(filtered.token_stats, stats.token_stats);
    const inspection = await f.draft.inspect({ view: 'costs', continuation: null, maxOutputBytes: 100000 }, signal());
    const observed = tokens.Parse(inspection); assert.deepEqual(observed.token_stats, stats.token_stats);
    assert(inspection.kind === 'costs'); assert.notEqual(inspection.measurement.units, stats.token_stats.total);
    const result = await f.draft.finalize(signal()); assert(result.kind === 'ready');
    const terminal = tokens.Parse(await f.draft.inspect({ view: 'costs', continuation: null, maxOutputBytes: 100000 }, signal()));
    assert.deepEqual(terminal.token_stats, stats.token_stats);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/reference-token-components.json', JSON.stringify({ selected, inspection, terminal }, null, 2) + '\n');
  } finally { await f.draft.close(); await f.workspace.close(); await f.runtime.close(); }
});

test('reference preview uses proposed file totals and canonical tree and Git inputs', async () => {
  const f = await fixture('codeReview');
  try {
    const before = tokens.Parse(await f.draft.inspect({ view: 'costs', continuation: null, maxOutputBytes: 100000 }, signal()));
    const preview = await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'preview',
      paths: ['LongerBetaRoot/proposed-file-with-a-longer-name.txt'], maxOutputBytes: 100000 })), signal());
    const projected = tokens.Parse(preview);
    assert.notEqual(projected.token_stats.files_content, before.token_stats.files_content);
    assert.equal(projected.token_stats.file_tree, before.token_stats.file_tree);
    assert.equal(projected.token_stats.git, before.token_stats.git); assert(before.token_stats.git);
    assert.equal(f.draft.revision, 0);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/reference-token-preview.json', JSON.stringify({ before, preview }, null, 2) + '\n');
  } finally { await f.draft.close(); await f.workspace.close(); await f.runtime.close(); }
});

test('reference Git accounting follows artifact-path diagnostics even when export uses a selected patch', async () => {
  const f = await fixture('codeReview');
  try {
    const diff = gitValidator.Parse(gitValidator.Default({ op: 'diff', maxOutputBytes: 100000 })); assert(diff.op === 'diff');
    const publication = await f.draft.publishGitSnapshot(diff, { mode: 'standard', scope: 'all', snapshotID: 'tokens',
      inlineMap: true, inlineMode: 'brief', inlineMaxLines: 120 }, signal()); assert(publication.kind === 'single');
    const aliases = publication.projection.primarySelectionAliases;
    await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'set', paths: aliases, maxOutputBytes: 100000 })), signal());
    const selected = await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'content', maxOutputBytes: 100000 })), signal());
    const stats = tokens.Parse(selected);
    const bodies = await Promise.all(aliases.map(alias => readFile(join(f.out, alias), 'utf8')));
    assert.equal(stats.token_stats.files_content, bodies.reduce((sum, body) => sum + units(body), 0));
    const diagnostic = '===== REPOPROMPT REVIEW DIFF INCOMPLETE =====\n' +
      '- Selected path could not be resolved: Selected path 1\n' +
      '- Selected path could not be resolved: Selected path 2\n' +
      '===== END REPOPROMPT REVIEW DIFF INCOMPLETE =====';
    assert.equal(stats.token_stats.git, units(diagnostic));
    const result = await f.draft.finalize(signal()); assert(result.kind === 'ready');
    assert.equal(result.manifest.automaticGit, null);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/reference-token-git-artifacts.json', JSON.stringify({ aliases, selected, result }, null, 2) + '\n');
  } finally { await f.draft.close(); await f.workspace.close(); await f.runtime.close(); }
});
