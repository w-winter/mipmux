import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { type ContextBuildRequest, SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { gitProcess } from '../src/patches/git-process.js';
import { bytePairDiff } from '../src/patches/byte-pair-diff.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';

const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;
test('local exact-byte patches apply forward/reverse, remain read-only and enforce staged/commit source coherence', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(resolve('test-output/git-'));
  const root = join(base, 'repo');
  await mkdir(root);
  await mkdir(join(base, 'out'));
  const run = (args: string[]) =>
    execFileSync(git, args, {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      encoding: 'utf8',
    });
  run(['init']);
  run(['config', 'user.name', 'Fixture']);
  run(['config', 'user.email', 'fixture@example.invalid']);
  const names = ['text.txt', 'quote"\né.txt', 'deleted.txt', 'empty.txt', 'binary.bin', 'mode.sh'];
  for (const name of names) {
    await writeFile(
      join(root, name),
      name === 'empty.txt' ? '' : name === 'binary.bin' ? Buffer.from([0, 1, 2]) : 'before\n',
    );
  }
  await writeFile(join(root, 'model.swift'), 'struct Model {\n let value: String\n}\n');
  run(['add', '--all']);
  run(['commit', '-m', 'fixture']);
  const commit = run(['rev-parse', 'HEAD']).trim();
  const index = await readFile(join(root, '.git/index'));
  await writeFile(join(root, 'text.txt'), 'after\r\n');
  await writeFile(join(root, 'quote"\né.txt'), 'after\n');
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 3, 4, 5]));
  await chmod(join(root, 'mode.sh'), 0o755);
  await unlink(join(root, 'deleted.txt'));
  await unlink(join(root, 'empty.txt'));
  await writeFile(join(root, 'untracked.txt'), 'added\n');
  await writeFile(join(root, 'empty-new.txt'), '');
  const options = {
    cachePath: join(base, 'cache'),
    terminationGraceMs: 100,
    contextBudgetUnits: 1000000, credentialPaths: [],
    git: { executable: git },
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' },
  };
  const runtime = new SmipRuntime(options);
  try {
    const workspace = await runtime.declare({
      roots: [{ name: 'r', absolutePath: root }],
      exclusions: [],
      outputRoot: join(base, 'out'),
    }, signal());
    const request: ContextBuildRequest = {
      task: 'Review patch',
      constraints: '',
      purpose: 'review',
      requiredSources: [{ kind: 'full', source: { root: 'r', path: 'text.txt' } }, {
        kind: 'codemap',
        source: { root: 'r', path: 'model.swift' },
      }, {
        kind: 'slices',
        source: { root: 'r', path: 'quote"\né.txt' },
        ranges: [{ start: 1, end: 1, description: 'Changed quoted source' }],
      }],
      documents: [{
        kind: 'suppliedDocument',
        id: 'plan',
        role: 'plan',
        origin: 'synthetic fixture',
        text: 'BEGIN PLAN\n' + 'Complete long plan.\n'.repeat(6000) + 'END PLAN',
      }, {
        kind: 'suppliedDocument',
        id: 'evidence',
        role: 'evidence',
        origin: 'synthetic fixture',
        text: 'Complete prior evidence.',
      }],
      patches: [{
        kind: 'localPatch',
        id: 'changes',
        root: 'r',
        comparison: { kind: 'worktree', base: { kind: 'commit', ref: commit }, includeUntracked: true },
        scope: { kind: 'all' },
      }],
      allowance: { kind: 'net', method: 'utf8-21-over-80-v1', overheadReserved: true, units: 100000 },
      discoveryHints: [],
      outputName: 'worktree',
    };
    const draft = await workspace.createDraft(request, signal());
    await draft.update({
      expectedRevision: 0,
      maxOutputBytes: 10000,
      mutation: {
        kind: 'handoff',
        handoff: { clarifiedTask: 'Review', architecture: 'Files', relationships: [], ambiguities: [] },
      },
    }, signal());
    const result = await draft.finalize(signal());
    if (result.kind !== 'ready') assert.fail(JSON.stringify(result));
    const verified = await verifyBundle(result.directory);
    await writeFile(
      resolve('test-output/group-c-mixed-packet.json'),
      JSON.stringify(
        { directory: result.directory, files: verified.manifest.files, accounting: verified.manifest.accounting },
        null,
        2,
      ) + '\n',
    );
    const patchRecord = verified.manifest.materials.find((m) => m.kind === 'patch');
    assert(patchRecord);
    const context = await readFile(join(result.directory, 'context.md'));
    const patch = context.subarray(
      patchRecord.spans[0]!.offset,
      patchRecord.spans[0]!.offset + patchRecord.spans[0]!.length,
    );
    const target = join(base, 'apply');
    await mkdir(target);
    await writeFile(join(base, 'base.tar'), execFileSync(git, ['archive', commit], { cwd: root }));
    execFileSync('tar', ['-xf', join(base, 'base.tar'), '-C', target]);
    execFileSync(git, ['init'], { cwd: target });
    const patchPath = join(base, 'change.patch');
    await writeFile(patchPath, patch);
    execFileSync(git, ['apply', '--check', patchPath], { cwd: target });
    execFileSync(git, ['apply', patchPath], { cwd: target });
    for (
      const name of [
        ...names.filter((n) => !['deleted.txt', 'empty.txt'].includes(n)),
        'untracked.txt',
        'empty-new.txt',
      ]
    ) {
      assert.deepEqual(await readFile(join(target, name)), await readFile(join(root, name)));
      assert.equal((await stat(join(target, name))).mode & 0o111, (await stat(join(root, name))).mode & 0o111);
    }
    for (const name of ['deleted.txt', 'empty.txt']) await assert.rejects(readFile(join(target, name)));
    execFileSync(git, ['apply', '--reverse', '--check', patchPath], { cwd: target });
    execFileSync(git, ['apply', '--reverse', patchPath], { cwd: target });
    assert.equal(await readFile(join(target, 'deleted.txt'), 'utf8'), 'before\n');
    assert.deepEqual(await readFile(join(root, '.git/index')), index);
    assert.equal(run(['rev-parse', 'HEAD']).trim(), commit);
    await verifyCurrentBundle(result.directory, runtime, signal());
    await writeFile(join(root, 'new-untracked.txt'), 'new');
    await assert.rejects(verifyCurrentBundle(result.directory, runtime, signal()));
    await draft.close();
    const staged = await workspace.createDraft({
      ...request,
      outputName: 'staged',
      patches: [{
        kind: 'localPatch',
        id: 'staged',
        root: 'r',
        scope: { kind: 'all' },
        comparison: { kind: 'staged', base: { kind: 'commit', ref: commit } },
      }],
    }, signal());
    const stagedResult = await staged.finalize(signal());
    assert.equal(stagedResult.kind, 'blocked');
    if (stagedResult.kind === 'blocked') {
      assert(stagedResult.diagnostics.some((d) => d.code === 'sourceComparisonMismatch'));
    }
    await staged.close();
    const historical = await workspace.createDraft({
      ...request,
      outputName: 'historical',
      patches: [{
        kind: 'localPatch',
        id: 'history',
        root: 'r',
        scope: { kind: 'all' },
        comparison: { kind: 'commits', base: { kind: 'commit', ref: commit }, target: commit },
      }],
    }, signal());
    assert.equal((await historical.finalize(signal())).kind, 'blocked');
    await historical.close();
    const matchRequest: ContextBuildRequest = {
      ...request,
      documents: [],
      outputName: 'matching',
      requiredSources: [{ kind: 'codemap', source: { root: 'r', path: 'model.swift' } }],
      patches: [{
        kind: 'localPatch',
        id: 'history',
        root: 'r',
        scope: { kind: 'all' },
        comparison: { kind: 'commits', base: { kind: 'empty' }, target: commit },
      }],
    };
    const marker = join(base, 'executed');
    run(['config', 'core.fsmonitor', `touch ${marker}`]);
    run(['config', 'diff.external', `touch ${marker}`]);
    run(['config', 'filter.evil.smudge', `touch ${marker}`]);
    run(['config', 'filter.evil.clean', `touch ${marker}`]);
    await writeFile(join(root, '.gitattributes'), '* filter=evil diff=evil\n');
    run(['config', 'diff.evil.textconv', `touch ${marker}`]);
    const objectNames = await readdir(join(root, '.git/objects'), { recursive: true });
    const matching = await workspace.createDraft(matchRequest, signal());
    await matching.update({
      expectedRevision: 0,
      maxOutputBytes: 10000,
      mutation: {
        kind: 'handoff',
        handoff: { clarifiedTask: 'Review', architecture: 'Files', relationships: [], ambiguities: [] },
      },
    }, signal());
    assert.equal((await matching.finalize(signal())).kind, 'ready');
    await matching.close();
    await assert.rejects(readFile(marker));
    assert.deepEqual(await readdir(join(root, '.git/objects'), { recursive: true }), objectNames);
    for (
      const key of ['core.fsmonitor', 'diff.external', 'filter.evil.smudge', 'filter.evil.clean', 'diff.evil.textconv']
    ) run(['config', '--unset', key]);
    await symlink('text.txt', join(root, 'link'));
    await assert.rejects(
      workspace.createDraft({ ...request, outputName: 'untracked-link' }, signal()),
      /unsupportedComparisonEntry/,
    );
    run(['config', 'core.fsmonitor', 'false']);
    run(['add', '--', 'link']);
    await assert.rejects(
      workspace.createDraft({
        ...matchRequest,
        patches: [{
          kind: 'localPatch',
          id: 'unsupported',
          root: 'r',
          scope: { kind: 'all' },
          comparison: { kind: 'staged', base: { kind: 'empty' } },
        }],
      }, signal()),
      /unsupportedComparisonEntry/,
    );
    run(['update-index', '--force-remove', 'link']);
    const blob = run(['rev-parse', commit + ':text.txt']).trim();
    for (const entry of [`100644 ${blob} 1\tunsupported\n`, `160000 ${commit} 0\tunsupported\n`]) {
      execFileSync(git, ['update-index', '--index-info'], {
        cwd: root,
        input: entry,
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
      await assert.rejects(
        workspace.createDraft({
          ...matchRequest,
          patches: [{
            kind: 'localPatch',
            id: 'unsupported',
            root: 'r',
            scope: { kind: 'all' },
            comparison: { kind: 'staged', base: { kind: 'empty' } },
          }],
        }, signal()),
        /unsupportedComparisonEntry/,
      );
      run(['update-index', '--force-remove', 'unsupported']);
    }
    await assert.rejects(readFile(marker));
    const missingBlob = run(['rev-parse', commit + ':model.swift']).trim();
    await unlink(join(root, '.git/objects', missingBlob.slice(0, 2), missingBlob.slice(2)));
    const fetchMarker = join(base, 'fetch-executed');
    run(['config', 'remote.origin.promisor', 'true']);
    run(['config', 'remote.origin.url', `ext::/usr/bin/touch ${fetchMarker}`]);
    run(['config', 'protocol.ext.allow', 'always']);
    await assert.rejects(
      workspace.createDraft({ ...matchRequest, outputName: 'missing-object' }, signal()),
      /gitAcquisitionFailed/,
    );
    await assert.rejects(readFile(fetchMarker));
    await workspace.close();
  } finally {
    await runtime.close();
  }
});

test('Git exit one with missing input has diagnostics and no applicable patch', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(resolve('test-output/missing-diff-'));
  await writeFile(join(base, 'present'), 'body');
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  try {
    const result = await gitProcess(
      supervisor,
      git,
      base,
      ['diff', '--no-index', '--', 'missing', 'present'],
      signal(),
      { kind: 'scratch', ceiling: base },
    );
    assert.equal(result.code, 1);
    assert.equal(result.diagnostics, true);
    assert.equal(result.bytes.length, 0);
  } finally {
    await supervisor.close();
  }
});

test('byte-pair cleanup removes only its nested scratch after process closure on success, failure and cancellation', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(resolve('test-output/diff-cleanup-'));
  const workRoot = join(base, 'work');
  const sibling = join(workRoot, 'retained', 'evidence');
  await mkdir(join(workRoot, 'retained'), { recursive: true });
  await writeFile(sibling, 'Retained evidence');
  const waitingGit = join(base, 'waiting-git');
  await writeFile(waitingGit, `#!${process.execPath}\nprocess.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n`, { mode: 0o700 });

  for (const outcome of ['success', 'failure', 'cancellation'] as const) {
    const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
    const controller = new AbortController();
    const scratchAtClose: Promise<boolean>[] = [];
    const spawn = supervisor.spawn.bind(supervisor);
    supervisor.spawn = spec => {
      const owned = spawn(spec);
      scratchAtClose.push(owned.closed.then(() => existsSync(spec.cwd)));
      if (outcome === 'cancellation') owned.child.stdout.once('data', () => controller.abort());
      return owned;
    };
    try {
      const comparison = bytePairDiff(
        supervisor,
        outcome === 'success' ? git : outcome === 'failure' ? '/usr/bin/false' : waitingGit,
        workRoot,
        'nested/source/file.txt',
        { kind: 'file', bytes: Buffer.from('before\n'), mode: '100644' },
        { kind: 'file', bytes: Buffer.from('after\n'), mode: '100644' },
        controller.signal,
      );
      if (outcome === 'success') assert.match((await comparison).toString(), /^diff --git /);
      else await assert.rejects(comparison, outcome === 'failure' ? /patchComparisonFailed/ : /abort/i);
      assert.deepEqual(await Promise.all(scratchAtClose), [true]);
      assert.deepEqual(await readdir(workRoot), ['retained']);
      assert.equal(await readFile(sibling, 'utf8'), 'Retained evidence');
    } finally {
      await supervisor.close();
    }
  }
});
