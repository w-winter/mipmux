import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import { SmipRuntime, verifyBundle, verifyCurrentBundle, type ContextBuildRequest, type Manifest } from '../src/index.js';
import { acquireLocalPatch } from '../src/patches/local-git.js';
import { identity } from '../src/context/material-store.js';
import { loadVerifiedBundle } from '../src/context/verify.js';
import { renderBundle } from '../src/context/render.js';
import { prepareClipboard } from '../src/context/clipboard.js';
import { finalFileTreeInput } from '../src/context/final-tree.js';
import { canonicalJSON, sha256 } from '../src/workspace/values.js';

const signal = () => new AbortController().signal;
const handoff = { clarifiedTask: 'Inspect exact evidence', architecture: 'Synthetic files', relationships: [], ambiguities: [] };
const request: ContextBuildRequest = { task: 'Complete task', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: 'Complete evidence', enhancementMode: 'augment' as const, purpose: 'review',
  requiredSources: [], documents: [], patches: [], discoveryHints: [], outputName: 'packet',
  budgetUnits: 1000000 };
async function fixture() {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'smip-context-corrections-'));
  const root = join(directory, 'source'), output = join(directory, 'out');
  await mkdir(root); await mkdir(output);
  const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(directory, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' }, git: { executable: git } });
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output };
  return { directory, root, output, runtime, spec, run };
}

test('integrity rejects tampered spans and malformed text even when outer file identities are updated', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'slice.txt'), 'BEGIN\n🙂 middle\nEND\n');
    const workspace = await f.runtime.declare(f.spec, signal());
    const draft = await workspace.createDraft({ ...request, requiredSources: [{ kind: 'slices',
      source: { root: 'r', path: 'slice.txt' }, ranges: [{ start: 2, end: 2, description: 'middle' }] }],
      documents: [{ kind: 'suppliedDocument', id: 'a', role: 'plan', origin: 'fixture', text: 'PLAN\n' },
        { kind: 'suppliedDocument', id: 'b', role: 'report', origin: 'fixture', text: 'REPORT\n' }] }, signal());
    await draft.update({ expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) } }, signal());
    const result = await draft.finalize(signal()); assert(result.kind === 'ready');
    const manifestPath = join(result.directory, 'manifest.json'), contextPath = join(result.directory, 'context.md');
    const saved = await readFile(manifestPath), context = await readFile(contextPath);
    const manifest = result.manifest;
    const reject = async (changed: Manifest, bytes = context) => {
      changed.files.context = identity(bytes);
      await writeFile(manifestPath, JSON.stringify(changed)); await writeFile(contextPath, bytes);
      await assert.rejects(verifyBundle(result.directory), /bundleIntegrityFailed/);
    };
    try {
      await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: context.length }), async shift => {
        const changed = structuredClone(manifest);
        changed.materials.at(-1)!.spans[0]!.offset += shift;
        await reject(changed);
      }));
      const digest = structuredClone(manifest); digest.materials[0]!.spans[0]!.sha256 = '0'.repeat(64); await reject(digest);
      const reordered = structuredClone(manifest); reordered.materials.reverse(); await reject(reordered);
      const overlap = structuredClone(manifest); overlap.materials[1]!.spans[0]!.offset = overlap.materials[0]!.spans[0]!.offset; await reject(overlap);
      const malformed = Buffer.from(context); malformed[manifest.materials.at(-1)!.spans[0]!.offset] = 0xff;
      const changed = structuredClone(manifest);
      const span = changed.materials.at(-1)!.spans[0]!;
      span.sha256 = identity(malformed.subarray(span.offset, span.offset + span.length)).sha256;
      await reject(changed, malformed);
    } finally { await writeFile(manifestPath, saved); await writeFile(contextPath, context); }
    await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, f.runtime, signal());
    await writeFile(join(f.directory, 'integrity-proof.json'), JSON.stringify({ directory: result.directory, cases: ['shifted', 'outOfRange', 'digest', 'reordered', 'overlap', 'malformedUTF8'], files: manifest.files }) + '\n');
    await draft.close(); await workspace.close();
  } finally { await f.runtime.close(); }
});

test('scoped untracked comparisons use current admitted membership, preserve deletions and reject stale receipts', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'scope'));
    await writeFile(join(f.root, '.gitignore'), '*.ignored\n');
    await writeFile(join(f.root, 'scope/deleted.txt'), 'DELETE\n');
    f.run(['init']); f.run(['config', 'user.name', 'Fixture']); f.run(['config', 'user.email', 'fixture@example.invalid']);
    f.run(['add', '--all']); f.run(['commit', '-m', 'baseline']); const base = f.run(['rev-parse', 'HEAD']).trim();
    await writeFile(join(f.root, 'scope/gone.txt'), 'STALE\n');
    await writeFile(join(f.root, 'scope/new.txt'), 'ADD\n');
    await writeFile(join(f.root, 'scope/hidden.ignored'), 'IGNORED\n');
    await writeFile(join(f.root, 'outside.txt'), 'OUTSIDE\n');
    const workspace = await f.runtime.declare(f.spec, signal()); await workspace.refresh(signal());
    const operation = await workspace.openOperation(signal());
    await unlink(join(f.root, 'scope/gone.txt')); await unlink(join(f.root, 'scope/deleted.txt'));
    const input = { kind: 'localPatch' as const, id: 'scoped', root: 'r', scope: { kind: 'paths' as const, paths: ['scope'] },
      comparison: { kind: 'worktree' as const, base: { kind: 'commit' as const, ref: base }, includeUntracked: true } };
    const acquired = await acquireLocalPatch(operation, input);
    assert.deepEqual(acquired.receipt.coverage, ['scope/deleted.txt', 'scope/new.txt']);
    assert(!acquired.receipt.policies.some(control => control.path === 'scope/gone.txt'));
    assert.match(acquired.bytes.toString(), /-DELETE/); assert.match(acquired.bytes.toString(), /\+ADD/);
    assert(!acquired.bytes.includes(Buffer.from('OUTSIDE'))); assert(!acquired.bytes.includes(Buffer.from('IGNORED')));
    assert.deepEqual((await acquireLocalPatch(operation, input, acquired.receipt)).bytes, acquired.bytes);
    await writeFile(join(f.root, 'scope/later.txt'), 'LATER\n');
    await assert.rejects(acquireLocalPatch(operation, input, acquired.receipt), /comparisonChanged/);
    await unlink(join(f.root, 'scope/later.txt'));
    await writeFile(join(f.root, '.gitignore'), '*.ignored\nnew.txt\n');
    await assert.rejects(acquireLocalPatch(operation, input, acquired.receipt), /comparisonChanged/);
    await operation.close(); await workspace.close();
  } finally { await f.runtime.close(); }
});

test('large local comparison exports compact review metadata with complete patch and manifest evidence', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, '.gitignore'), '# POLICY TEXT ONLY IN MANIFEST\n');
    for (let index = 0; index < 500; index++) await writeFile(join(f.root, `file-${String(index).padStart(3, '0')}.txt`), 'before\n');
    f.run(['init']); f.run(['config', 'user.name', 'Fixture']); f.run(['config', 'user.email', 'fixture@example.invalid']);
    f.run(['add', '--all']); f.run(['commit', '-m', 'baseline']); const base = f.run(['rev-parse', 'HEAD']).trim();
    await writeFile(join(f.root, 'file-000.txt'), 'after\n');
    const workspace = await f.runtime.declare(f.spec, signal());
    const draft = await workspace.createDraft({ ...request, patches: [{ kind: 'localPatch', id: 'change', root: 'r',
      comparison: { kind: 'worktree', base: { kind: 'commit', ref: base }, includeUntracked: true }, scope: { kind: 'all' } }] }, signal());
    await draft.update({ expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) } }, signal());
    const result = await draft.finalize(signal()); assert(result.kind === 'ready');
    await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, f.runtime, signal());
    const context = await readFile(join(result.directory, 'context.md'));
    const record = result.manifest.materials[0]; assert(record?.kind === 'patch');
    const span = record.spans[0]!; const patch = context.subarray(span.offset, span.offset + span.length);
    const measurement = { directory: result.directory, context: identity(context), patch: identity(patch), units: result.manifest.accounting.units,
      policies: record.receipt.policies.length, targets: record.receipt.targets.length, manifest: identity(await readFile(join(result.directory, 'manifest.json'))) };
    await writeFile(join(f.directory, 'comparison-measurement.json'), JSON.stringify(measurement, null, 2) + '\n');
    assert.equal(record.receipt.policies.length, 501); assert.equal(record.receipt.targets.length, 501);
    assert.deepEqual(record.receipt.coverage, ['file-000.txt']);
    assert(!context.includes(Buffer.from('POLICY TEXT ONLY IN MANIFEST')));
    assert(!context.includes(Buffer.from('"targets":')));
    assert.equal(result.manifest.accounting.units, Number(21n * BigInt(context.length) / 80n));
    assert.match(patch.toString(), /-before\n\+after/);
    await draft.close(); await workspace.close();
  } finally { await f.runtime.close(); }
});

test('current verification rejects self-consistent forged slices against the exact acquired lines', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'slice.txt'), '\uFEFFfirst\r\n🙂 second\rthird\nlast');
    await writeFile(join(f.root, 'empty.txt'), '');
    const workspace = await f.runtime.declare(f.spec, signal());
    const draft = await workspace.createDraft({ ...request, requiredSources: [{ kind: 'slices',
      source: { root: 'r', path: 'slice.txt' }, ranges: [{ start: 2, end: 3, description: 'middle' },
        { start: 1, end: 2, description: 'overlapping BOM' }, { start: 4, end: 4, description: 'adjacent' }] },
      { kind: 'full', source: { root: 'r', path: 'empty.txt' } }] }, signal());
    await draft.update({ expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) } }, signal());
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    await verifyCurrentBundle(ready.directory, f.runtime, signal());
    const saved = await loadVerifiedBundle(ready.directory);
    const rejected: string[] = [];
    for (const scenario of ['wrongBody', 'beyondEOF', 'emptySlice'] as const) {
      const manifest = structuredClone(ready.manifest), materials = structuredClone(saved.materials);
      const material = materials.find(item => item.record.kind === 'source' && item.record.selection.kind === 'slices');
      assert(material?.record.kind === 'source' && material.record.selection.kind === 'slices');
      let bodies = material.bodies;
      if (scenario === 'wrongBody') {
        bodies = ['WRONG\r\n'];
      } else {
        const path = scenario === 'emptySlice' ? 'empty.txt' : 'slice.txt';
        const end = scenario === 'emptySlice' ? 1 : 5;
        if (scenario === 'emptySlice') {
          const empty = materials.find(item => item.record.kind === 'source' && item.record.selection.source.path === path);
          assert(empty?.record.kind === 'source');
          materials.splice(materials.indexOf(empty), 1);
          material.record.identity = empty.record.identity;
          material.record.decoding = empty.record.decoding;
          material.record.id = empty.record.id;
        }
        material.record.selection = { kind: 'slices', source: { root: 'r', path }, ranges: [{ start: 1, end, description: 'forged' }] };
        material.record.normalized = [{ start: 1, end, description: 'forged' }];
        manifest.request.requiredSources = [material.record.selection];
      }
      const [range] = material.record.normalized; assert(range);
      const label = range.start === range.end ? String(range.start) : range.start + '-' + range.end;
      const prefix = 'File: r/' + material.record.selection.source.path + '\n(lines ' + label +
        (range.description ? ': ' + range.description : '') + ')\n```txt\n';
      const body = bodies.join('');
      materials[materials.indexOf(material)] = { ...material, bodies, sourceBlock: { text: prefix + body + '\n```',
        bodySpans: [{ offset: Buffer.byteLength(prefix), length: Buffer.byteLength(body) }] } };
      const rendered = renderBundle(await prepareClipboard(f.runtime, { manualPresentation: null, codemapMode: manifest.codemapMode, request: manifest.request, inventory: manifest.inventory, prompt: manifest.prompt, materials,
        automaticAcquisition: { kind: 'settled', outcomes: manifest.automaticCodemaps }, unavailableRoots: manifest.unavailableRoots, unavailableFiles: manifest.unavailableFiles,
        fileTree: { input: finalFileTreeInput(manifest.inventory, materials, manifest.codemapMode, manifest.unavailableRoots, manifest.unavailableFiles), text: saved.fileTree.text } }, signal(), { kind: 'captured', capture: saved.automaticGit }));
      manifest.fileTree = { input: finalFileTreeInput(manifest.inventory, materials, manifest.codemapMode, manifest.unavailableRoots, manifest.unavailableFiles), span: rendered.fileTreeSpan };
      manifest.requestDigest = sha256(canonicalJSON(manifest.request));
      manifest.materials = rendered.records;
      manifest.files = { context: identity(rendered.context), handoff: identity(rendered.handoff) };
      manifest.accounting.bytes = rendered.measurement.bytes; manifest.accounting.units = rendered.measurement.units;
      await writeFile(join(ready.directory, 'context.md'), rendered.context);
      await writeFile(join(ready.directory, 'handoff.md'), rendered.handoff);
      await writeFile(join(ready.directory, 'manifest.json'), canonicalJSON(manifest));
      await verifyBundle(ready.directory);
      await assert.rejects(verifyCurrentBundle(ready.directory, f.runtime, signal()), /invalidRange|materialChanged/);
      rejected.push(scenario);
    }
    await writeFile(join(f.directory, 'slice-verification-proof.json'), JSON.stringify({ rejected }) + '\n');
    await draft.close(); await workspace.close();
  } finally { await f.runtime.close(); }
});

test('integrity reestablishes supplied patch input and receipt agreement without changing recipient bytes', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'source.txt'), 'SOURCE\n');
    const workspace = await f.runtime.declare(f.spec, signal());
    const draft = await workspace.createDraft({ ...request, requiredSources: [{ kind: 'full', source: { root: 'r', path: 'source.txt' } }],
      patches: [{ kind: 'suppliedPatch', id: 'external', root: 'r', text: 'opaque complete patch\n', origin: 'fixture',
        comparison: { kind: 'supplied', base: 'before', target: 'after' }, coverage: ['source.txt'],
        targets: [{ path: 'source.txt', identity: identity('SOURCE\n'), mode: '100644' }] }] }, signal());
    await draft.update({ expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) } }, signal());
    const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
    const originalContext = await readFile(join(ready.directory, 'context.md'));
    for (const scenario of ['targets', 'coverage', 'repository'] as const) {
      const manifest = structuredClone(ready.manifest);
      const patch = manifest.materials.find(item => item.kind === 'patch');
      const input = manifest.request.patches[0];
      assert(patch?.kind === 'patch' && input?.kind === 'suppliedPatch' && patch.receipt.input.kind === 'suppliedPatch');
      if (scenario === 'targets') {
        input.targets[0]!.identity = identity('DIFFERENT\n');
        patch.receipt.input.targets = input.targets;
      } else if (scenario === 'coverage') {
        input.coverage = ['different.txt']; patch.receipt.input.coverage = input.coverage;
      } else {
        patch.receipt.repository = { worktree: manifest.inventory.roots[0]!.identity, gitDirectory: manifest.inventory.roots[0]!.identity,
          head: null, base: null, target: null, indexDigest: null };
      }
      manifest.requestDigest = sha256(canonicalJSON(manifest.request));
      // Repository metadata is projected, so render that contradiction as a consistent packet too.
      if (scenario === 'repository') {
        const saved = await loadVerifiedBundle(ready.directory);
        const material = saved.materials.find(item => item.record.kind === 'patch'); assert(material);
        const materials = saved.materials.map(item => item === material ? { ...item, record: patch } : item);
        const rendered = renderBundle(await prepareClipboard(f.runtime, { manualPresentation: null, codemapMode: manifest.codemapMode, request: manifest.request, inventory: manifest.inventory, prompt: manifest.prompt, materials, fileTree: saved.fileTree,
          automaticAcquisition: { kind: 'settled', outcomes: manifest.automaticCodemaps }, unavailableRoots: manifest.unavailableRoots, unavailableFiles: manifest.unavailableFiles }, signal(), { kind: 'captured', capture: saved.automaticGit }));
        manifest.fileTree.span = rendered.fileTreeSpan;
        manifest.materials = rendered.records; manifest.files = { context: identity(rendered.context), handoff: identity(rendered.handoff) };
        manifest.accounting.bytes = rendered.measurement.bytes; manifest.accounting.units = rendered.measurement.units;
        await writeFile(join(ready.directory, 'context.md'), rendered.context); await writeFile(join(ready.directory, 'handoff.md'), rendered.handoff);
      } else assert.deepEqual(await readFile(join(ready.directory, 'context.md')), originalContext);
      await writeFile(join(ready.directory, 'manifest.json'), canonicalJSON(manifest));
      await assert.rejects(verifyBundle(ready.directory), /bundleIntegrityFailed/);
      await writeFile(join(ready.directory, 'manifest.json'), canonicalJSON(ready.manifest));
    }
    await writeFile(join(f.directory, 'supplied-receipt-proof.json'), JSON.stringify({ rejected: ['targets', 'coverage', 'repository'] }) + '\n');
    await draft.close(); await workspace.close();
  } finally { await f.runtime.close(); }
});

test('scoped and excluded Git comparisons ignore unrelated nonregular entries but retain supporting evidence', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'scope'));
    await writeFile(join(f.root, 'scope/change.sh'), 'before\n');
    await writeFile(join(f.root, 'support.txt'), 'support\n');
    await symlink('support.txt', join(f.root, 'link'));
    f.run(['init']); f.run(['config', 'user.name', 'Fixture']); f.run(['config', 'user.email', 'fixture@example.invalid']);
    f.run(['add', '--all']); f.run(['commit', '-m', 'baseline']); const base = f.run(['rev-parse', 'HEAD']).trim();
    f.run(['update-index', '--add', '--cacheinfo', `160000,${base},module`]);
    await writeFile(join(f.root, 'scope/change.sh'), 'after\n'); await chmod(join(f.root, 'scope/change.sh'), 0o755);
    f.run(['add', '--', 'scope/change.sh']); f.run(['commit', '-m', 'target']); const target = f.run(['rev-parse', 'HEAD']).trim();
    const index = await readFile(join(f.root, '.git/index')), head = f.run(['rev-parse', 'HEAD']);
    const receipts = [];
    for (const scope of ['restricted', 'excluded'] as const) {
      const workspace = await f.runtime.declare({ ...f.spec, exclusions: scope === 'excluded'
        ? [{ kind: 'prefix', root: 'r', path: 'link' }, { kind: 'prefix', root: 'r', path: 'module' }] : [] }, signal());
      for (const comparison of [
        { kind: 'worktree' as const, base: { kind: 'commit' as const, ref: base }, includeUntracked: false },
        { kind: 'staged' as const, base: { kind: 'commit' as const, ref: base } },
        { kind: 'commits' as const, base: { kind: 'commit' as const, ref: base }, target },
      ]) {
        const patch = { kind: 'localPatch' as const, id: scope + comparison.kind, root: 'r', comparison,
          scope: scope === 'restricted' ? { kind: 'paths' as const, paths: ['scope'] } : { kind: 'all' as const } };
        const operation = await workspace.openOperation(signal());
        try {
          const acquired = await acquireLocalPatch(operation, patch);
          assert.deepEqual(acquired.receipt.coverage, ['scope/change.sh']);
          assert.match(acquired.bytes.toString(), /old mode 100644\nnew mode 100755/);
          if (comparison.kind !== 'worktree') assert(acquired.receipt.targets.some(item => item.path === 'support.txt'));
          receipts.push(acquired.receipt);
          const directory = join(f.directory, scope + comparison.kind); await mkdir(directory); await mkdir(join(directory, 'scope'));
          execFileSync(f.runtime.options.git!.executable, ['init'], { cwd: directory });
          await writeFile(join(directory, 'scope/change.sh'), 'before\n');
          const patchPath = join(f.directory, scope + comparison.kind + '.patch'); await writeFile(patchPath, acquired.bytes);
          const apply = (args: string[]) => execFileSync(f.runtime.options.git!.executable, args, { cwd: directory });
          apply(['apply', '--check', patchPath]); apply(['apply', patchPath]);
          assert.equal(await readFile(join(directory, 'scope/change.sh'), 'utf8'), 'after\n');
          assert.equal((await stat(join(directory, 'scope/change.sh'))).mode & 0o111, 0o111);
          apply(['apply', '--reverse', '--check', patchPath]); apply(['apply', '--reverse', patchPath]);
          assert.equal(await readFile(join(directory, 'scope/change.sh'), 'utf8'), 'before\n');
          assert.equal((await stat(join(directory, 'scope/change.sh'))).mode & 0o111, 0);
        } finally { await operation.close(); }
        if (comparison.kind !== 'worktree') {
          const draft = await workspace.createDraft({ ...request, outputName: patch.id, patches: [patch],
            requiredSources: [{ kind: 'full', source: { root: 'r', path: 'support.txt' } }] }, signal());
          await draft.update({ expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) } }, signal());
          const ready = await draft.finalize(signal()); assert(ready.kind === 'ready');
          await verifyCurrentBundle(ready.directory, f.runtime, signal()); await draft.close();
          await writeFile(join(f.root, 'support.txt'), 'mismatch\n');
          const mismatch = await workspace.createDraft({ ...request, outputName: 'mismatch-' + patch.id, patches: [patch],
            requiredSources: [{ kind: 'full', source: { root: 'r', path: 'support.txt' } }] }, signal());
          const validation = await mismatch.validate(signal()); assert(validation.diagnostics.some(item => item.code === 'sourceComparisonMismatch'));
          await mismatch.close(); await writeFile(join(f.root, 'support.txt'), 'support\n');
        }
      }
      await workspace.close();
    }
    assert.deepEqual(await readFile(join(f.root, '.git/index')), index); assert.equal(f.run(['rev-parse', 'HEAD']), head);
    const workspace = await f.runtime.declare(f.spec, signal()), operation = await workspace.openOperation(signal());
    try {
      for (const path of ['link', 'module']) await assert.rejects(acquireLocalPatch(operation, {
        kind: 'localPatch', id: path, root: 'r', scope: { kind: 'paths', paths: [path] },
        comparison: { kind: 'commits', base: { kind: 'empty' }, target },
      }), /unsupportedComparisonEntry/);
    } finally { await operation.close(); await workspace.close(); }
    await writeFile(join(f.directory, 'scoped-git-proof.json'), JSON.stringify({ receipts, head, index: identity(index) }) + '\n');
  } finally { await f.runtime.close(); }
});
