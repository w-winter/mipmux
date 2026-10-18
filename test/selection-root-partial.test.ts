import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime, type ContextBuildRequest } from '../src/index.js';
import { selectionValidator } from '../src/contracts/selection.js';

const signal = () => new AbortController().signal;
const partial = Compile(Type.Object({ revision: Type.Integer(), files: Type.Array(Type.Object({ path: Type.String(), tokens: Type.Integer(), render_mode: Type.String() })),
  blocks: Type.Array(Type.String()), measurement: Type.Object({ complete: Type.Boolean() }),
  token_accounting: Type.Object({ incomplete_components: Type.Array(Type.String()) }),
  unavailable_sources: Type.Array(Type.Object({ root: Type.String(), path: Type.String(), code: Type.String(), required: Type.Boolean() })) }));
const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');

for (const mode of ['manual', 'automatic'] as const) for (const preset of ['standard', 'codeReview'] as const) {
  test(`${mode} ${preset} selection retains healthy content when another root is replaced`, async () => {
    const base = await mkdtemp(join(tmpdir(), 'smip-selection-partial-'));
    const a = join(base, 'a'), b = join(base, 'b'), out = join(base, 'out'); await mkdir(a); await mkdir(b); await mkdir(out);
    for (const [root, name] of [[a, 'Unavailable'], [b, 'Healthy']] as const) {
      await writeFile(join(root, 'Seed.swift'), `struct ${name}Seed { let peer: ${name}Peer }\n`);
      await writeFile(join(root, 'Peer.swift'), `struct ${name}Peer { let value: String }\n`);
    }
    await writeFile(join(a, 'slice.txt'), 'first\nselected missing-root line\nthird\n');
    const run = (args: string[]) => execFileSync(git, args, { cwd: b, encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
    run(['add', '.']); run(['commit', '-qm', 'base']);
    const runtime = new SmipRuntime({ cachePath: join(base, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [],
      nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
      terminationGraceMs: 100, git: { executable: git } });
    try {
      const workspace = await runtime.declare({ roots: [{ name: 'a', absolutePath: a }, { name: 'b', absolutePath: b }], exclusions: [], outputRoot: out }, signal());
      const sources = [{ kind: 'full' as const, source: { root: 'a', path: 'Seed.swift' } },
        { kind: 'slices' as const, source: { root: 'a', path: 'slice.txt' }, ranges: [{ start: 2, end: 2, description: null }] },
        { kind: 'full' as const, source: { root: 'b', path: 'Seed.swift' } }];
      const initialSelection: ContextBuildRequest['initialSelection'] = mode === 'automatic' ? { codemapMode: mode, sources }
        : { codemapMode: mode, sources: [...sources, { kind: 'codemap', source: { root: 'a', path: 'Peer.swift' } },
          { kind: 'codemap', source: { root: 'b', path: 'Peer.swift' } }] };
      const draft = await workspace.createDraft({ task: 'Inspect both roots', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
        initialSelection, requiredSources: [], documents: [], patches: [], discoveryHints: [], budgetUnits: 200000,
        outputName: 'packet', copyPreset: preset, storedPrompts: [], duplicateUserInstructionsAtTop: false }, signal());
      try {
        const selected = draft.selectionProjection();
        await rename(a, join(base, 'old-a')); await mkdir(a);
        await writeFile(join(a, 'Seed.swift'), 'UNAUTHORIZED REPLACEMENT CONTENT\n');
        await writeFile(join(a, 'slice.txt'), 'UNAUTHORIZED REPLACEMENT SLICE\n');
        const get = () => draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'content', maxOutputBytes: 100000 })), signal());
        const result = partial.Parse(await get());
        assert.equal(result.revision, 0); assert.deepEqual(draft.selectionProjection(), selected);
        assert(result.files.some(file => file.path === 'a/Seed.swift' && file.render_mode === 'full' && file.tokens === 0));
        assert(result.files.some(file => file.path === 'a/slice.txt' && file.render_mode === 'slice' && file.tokens === 0));
        assert(result.blocks.some(block => block.includes('HealthySeed')));
        assert(result.blocks.some(block => block.includes('HealthyPeer')));
        assert(!result.blocks.some(block => block.includes('Unavailable') || block.includes('selected missing-root line') || block.includes('UNAUTHORIZED')));
        assert(result.unavailable_sources.some(source => source.root === 'a' && source.path === 'Seed.swift' && source.code === 'rootChanged' && !source.required));
        assert.equal(result.measurement.complete, false);
        assert.deepEqual(result.token_accounting.incomplete_components, mode === 'manual' ? ['files', 'codemap_presentation'] : ['files']);
        await workspace.refresh(signal());
        const afterRefresh = partial.Parse(await get());
        assert(!afterRefresh.files.some(file => file.path.startsWith('a/')));
        assert(afterRefresh.blocks.some(block => block.includes('HealthySeed')));
        assert.deepEqual(draft.selectionProjection(), selected);
        await mkdir('test-output', { recursive: true });
        await writeFile(`test-output/selection-root-partial-${mode}-${preset}.json`, JSON.stringify({ result, afterRefresh, selected }, null, 2) + '\n');
      } finally { await draft.close(); }
      await workspace.close();
    } finally { await runtime.close(); }
  });
}

test('unavailable required source stays selected and prevents packet publication', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-required-root-'));
  const a = join(base, 'a'), b = join(base, 'b'), out = join(base, 'out'); await mkdir(a); await mkdir(b); await mkdir(out);
  await writeFile(join(a, 'required.txt'), 'Required original\n'); await writeFile(join(b, 'healthy.txt'), 'Healthy body\n');
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'a', absolutePath: a }, { name: 'b', absolutePath: b }], exclusions: [], outputRoot: out }, signal());
    const draft = await workspace.createDraft({ task: 'Keep required evidence', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'b', path: 'healthy.txt' } }] },
      requiredSources: [{ kind: 'full', source: { root: 'a', path: 'required.txt' } }], documents: [], patches: [], discoveryHints: [],
      budgetUnits: 200000, outputName: 'packet', copyPreset: 'standard', storedPrompts: [], duplicateUserInstructionsAtTop: false }, signal());
    try {
      await rename(a, join(base, 'old-a'));
      const result = partial.Parse(await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'content', maxOutputBytes: 100000 })), signal()));
      assert(result.unavailable_sources.some(source => source.path === 'required.txt' && source.required));
      assert(result.blocks.some(block => block.includes('Healthy body')));
      await assert.rejects(draft.finalize(signal()), /rootChanged|notFound/);
      await assert.rejects(readFile(join(out, 'packet/manifest.json')), /ENOENT/);
    } finally { await draft.close(); }
    await workspace.close();
  } finally { await runtime.close(); }
});

test('content view loads full files and slices, withholding unreadable leaves without hiding healthy siblings', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-selection-leaf-'));
  const root = join(base, 'root'), out = join(base, 'out'); await mkdir(root); await mkdir(out);
  await writeFile(join(root, 'full.txt'), 'captured full content\n');
  await writeFile(join(root, 'slice.txt'), 'first\ncaptured slice content\nlast\n');
  await writeFile(join(root, 'healthy.txt'), 'healthy sibling content\n');
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal());
    const draft = await workspace.createDraft({ task: 'Read selected content', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'r', path: 'full.txt' } },
        { kind: 'slices', source: { root: 'r', path: 'slice.txt' }, ranges: [{ start: 2, end: 2, description: null }] },
        { kind: 'full', source: { root: 'r', path: 'healthy.txt' } }] },
      requiredSources: [], documents: [], patches: [], discoveryHints: [], budgetUnits: 100000, outputName: 'packet',
      copyPreset: 'standard', storedPrompts: [], duplicateUserInstructionsAtTop: false }, signal());
    const original = draft.selectionProjection();
    const get = () => draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'content', maxOutputBytes: 100000 })), signal());
    for (const path of ['full.txt', 'slice.txt']) await rename(join(root, path), join(base, path));
    const unavailable = partial.Parse(await get());
    assert(unavailable.blocks.some(block => block.includes('healthy sibling content')));
    assert(!unavailable.blocks.some(block => block.includes('captured full content') || block.includes('captured slice content')));
    assert.deepEqual(unavailable.unavailable_sources.map(source => [source.path, source.code]).sort(), [['full.txt', 'notFound'], ['slice.txt', 'notFound']]);
    assert.deepEqual(unavailable.files.filter(file => file.path !== 'healthy.txt').map(file => [file.path, file.render_mode, file.tokens]).sort(),
      [['full.txt', 'full', 0], ['slice.txt', 'slice', 0]]);
    assert.equal(unavailable.measurement.complete, false); assert.equal(unavailable.revision, 0);
    assert.deepEqual(draft.selectionProjection(), original);
    for (const path of ['full.txt', 'slice.txt']) await rename(join(base, path), join(root, path));
    const recovered = partial.Parse(await get());
    assert.equal(recovered.unavailable_sources.length, 0);
    assert(recovered.blocks.some(block => block.includes('captured full content')));
    assert(recovered.blocks.some(block => block.includes('captured slice content')));
    assert.deepEqual(draft.selectionProjection(), original);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/selection-leaf-content.json', JSON.stringify({ unavailable, recovered, original }, null, 2) + '\n');
  } finally { await runtime.close(); }
});
