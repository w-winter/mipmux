import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { GitInput, gitValidator } from '../src/contracts/git.js';
import { MipmuxRuntime } from '../src/runtime/mipmux-runtime.js';
import type { OwnedProcess, ProcessSpec } from '../src/runtime/process-supervisor.js';

const git = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;
const declaration = Compile(Type.Object({ kind: Type.Literal('workspace'), id: Type.String() }));
const reply = Compile(Type.Object({ kind: Type.String(), code: Type.Optional(Type.String()),
  exclusions: Type.Optional(Type.Array(Type.String())), diff: Type.Optional(Type.Object({ compare: Type.String(),
    detail: Type.Optional(Type.String()), totals: Type.Object({ files: Type.Integer(), insertions: Type.Integer(), deletions: Type.Integer() }),
    files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), status: Type.String(),
      hunks: Type.Optional(Type.Array(Type.Object({ header: Type.String(), patch: Type.String() }))) }))) })) }));

async function fixture() {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-scout-diff-'));
  await mkdir(join(base, 'repo/sub'), { recursive: true }); await mkdir(join(base, 'out'));
  const repo = await realpath(join(base, 'repo')), root = join(repo, 'sub');
  const run = (args: string[], cwd = repo) => execFileSync(git, args, { cwd, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_DATE: '2026-10-13T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-13T10:00:00Z' } });
  run(['init', '-q', '-b', 'main']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'file.swift'), 'one\nbase\n'); await writeFile(join(repo, 'outside.swift'), 'outside\n');
  await writeFile(join(repo, 'credential.swift'), 'PROTECTED_FIXTURE_BASE\n');
  await writeFile(join(root, 'literal*.swift'), 'literal\n'); await writeFile(join(root, 'literal-other.swift'), 'other\n');
  run(['add', '--', '.']); run(['commit', '-qm', 'base']); const first = run(['rev-parse', 'HEAD']).trim();
  await writeFile(join(root, 'file.swift'), 'one\ncommitted\n'); run(['add', '--', 'sub/file.swift']); run(['commit', '-qm', 'tip']);
  const tip = run(['rev-parse', 'HEAD']).trim();
  await writeFile(join(root, 'file.swift'), 'one\nstaged\n'); run(['add', '--', 'sub/file.swift']);
  await writeFile(join(root, 'file.swift'), 'one\nworktree\n'); await writeFile(join(repo, 'outside.swift'), 'outside changed\n');
  await writeFile(join(repo, 'credential.swift'), 'PROTECTED_FIXTURE_CHANGED\n');
  await writeFile(join(root, 'literal*.swift'), 'literal changed\n'); await writeFile(join(root, 'literal-other.swift'), 'other changed\n');
  await writeFile(join(root, 'added.swift'), 'new\nlast');
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 200000,
    credentialPaths: [join(repo, 'credential.swift')], nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, git: { executable: git } };
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: join(base, 'out') };
  return { base, repo, root, run, first, tip, options, spec };
}

test('public diff preserves comparison states, source pathspec semantics and repository-wide authority without protected bodies', async () => {
  const f = await fixture(), config = join(f.base, 'config.json'), index = await readFile(join(f.repo, '.git/index'));
  await writeFile(config, JSON.stringify({ ...f.options, discovery: null, defaultMaxOutputBytes: 100000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'scout-diff', version: '1' }), proof: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = declaration.Parse((await client.callTool({ name: 'workspace_declare', arguments: { spec: f.spec } })).structuredContent);
    const call = async (input: Omit<Static<typeof GitInput.anyOf[4]>, 'op' | 'root'>, maxOutputBytes = 100000) => {
      const result = await client.callTool({ name: 'git', arguments: { workspaceId: workspace.id,
        input: { op: 'diff', root: 'r', ...input }, maxOutputBytes } });
      proof.push(result); return reply.Parse(result.structuredContent);
    };
    const comparisons: readonly (readonly [string, string, string])[] = [
      ['uncommitted', 'worktree', 'committed'], ['staged', 'staged', 'committed'], ['unstaged', 'worktree', 'staged'],
      ['uncommitted-mergebase:HEAD', 'worktree', 'committed'], ['staged-mergebase:HEAD', 'staged', 'committed'],
      ['STAGED:MAIN', 'staged', 'committed'],
      [f.first + '..' + f.tip, 'committed', 'base'],
    ];
    for (const [compare, added, removed] of comparisons) {
      const result = await call({ compare, detail: 'full' }); assert.equal(result.kind, 'git', JSON.stringify(result));
      const file = result.diff?.files?.find(file => file.path === 'sub/file.swift'); assert(file?.hunks);
      const patch = file.hunks.map(hunk => hunk.patch).join(''); assert(patch.includes('+' + added)); assert(patch.includes('-' + removed));
      assert(!JSON.stringify(result).includes('PROTECTED_FIXTURE'));
    }
    const all = await call({ detail: 'full' }); assert(all.diff?.files); assert(all.diff.files.some(file => file.path === 'outside.swift'));
    assert(all.exclusions?.includes('credential.swift')); assert(all.diff.files.some(file => file.path === 'sub/added.swift'));
    const literal = await call({ path: join(f.root, 'literal*.swift') }); assert.equal(literal.diff?.detail, 'patches');
    assert.deepEqual(literal.diff.files?.map(file => file.path), ['sub/literal*.swift']);
    const glob = await call({ paths: ['sub/literal*.swift', ':(exclude)sub/literal-other.swift'], detail: 'files' });
    assert.deepEqual(glob.diff?.files?.map(file => file.path), ['sub/literal*.swift']);
    const missing = await call({ paths: [join(f.base, 'unrelated/file.swift')], detail: 'files' }); assert.equal(missing.diff?.totals.files, 0);
    assert.equal((await call({}, 1)).kind, 'outputBudgetTooSmall');
    const injected = join(f.base, 'injected-output'); assert.notEqual((await call({ compare: '--output=' + injected })).kind, 'git');
    assert.equal(existsSync(injected), false);
    assert.deepEqual(await readFile(join(f.repo, '.git/index')), index);
    const file = await client.callTool({ name: 'read_file', arguments: { workspaceId: workspace.id, input: { root: 'r', path: 'outside.swift' } } });
    assert.equal(file.isError, true, 'Repository evidence authority must not widen ordinary source reads');
    await writeFile('test-output/scout-diff-mcp-proof.json', JSON.stringify({ proof, indexUnchanged: true, ordinarySourceConfined: true }, null, 2) + '\n');
  } finally { await client.close(); }
});

test('diff admits only freshly verified advertised same-repository worktrees and retains logical credential exclusions', async () => {
  const f = await fixture(), linked = join(f.base, 'linked'), other = join(f.base, 'other');
  f.run(['worktree', 'add', '-q', '-b', 'linked', linked]); await mkdir(other); f.run(['init', '-q'], other);
  await writeFile(join(linked, 'outside.swift'), 'linked evidence\n'); await writeFile(join(linked, 'credential.swift'), 'PROTECTED_FIXTURE_LINKED\n');
  const runtime = new MipmuxRuntime(f.options), client = runtime.createClient(null), proof: unknown[] = [];
  try {
    const workspace = await client.declare({ ...f.spec, roots: [{ name: 'r', absolutePath: f.repo }] }, signal());
    const call = (worktree: string) => client.explore(workspace.id, { name: 'git', input: gitValidator.Parse(gitValidator.Default({
      op: 'diff', root: 'r', worktree, detail: 'full', maxOutputBytes: 100000 })) }, signal());
    const result = await call(linked); proof.push(result); const parsed = reply.Parse(result);
    assert.equal(parsed.kind, 'git'); assert(JSON.stringify(parsed).includes('linked evidence'));
    assert(!JSON.stringify(parsed).includes('PROTECTED_FIXTURE_LINKED')); assert(parsed.exclusions?.includes('credential.swift'));
    await assert.rejects(call(other), /gitRepositoryDenied/);
    await writeFile('test-output/scout-diff-worktree-proof.json', JSON.stringify(proof, null, 2) + '\n');
  } finally { await runtime.close(); }
});

test('diff rejects both endpoints of a staged rename from a protected path before exposing patch bodies', async () => {
  const f = await fixture();
  f.run(['mv', '--', 'credential.swift', 'exposed.swift']);
  const runtime = new MipmuxRuntime(f.options), client = runtime.createClient(null);
  try {
    const workspace = await client.declare(f.spec, signal());
    const input = gitValidator.Parse(gitValidator.Default({ op: 'diff', root: 'r', compare: 'staged', detail: 'full',
      detectRenames: true, maxOutputBytes: 100000 }));
    const result = reply.Parse(await client.explore(workspace.id, { name: 'git', input }, signal()));
    assert.equal(result.kind, 'git'); assert(!JSON.stringify(result).includes('PROTECTED_FIXTURE'));
    assert(result.exclusions); assert(result.exclusions.includes('credential.swift')); assert(result.exclusions.includes('exposed.swift'));
    assert(!result.diff?.files?.some(file => file.path === 'exposed.swift'));
    await writeFile('test-output/scout-diff-protected-rename-proof.json', JSON.stringify(result, null, 2) + '\n');
  } finally { await runtime.close(); }
});

test('cancelling diff during body statistics joins its child and leaves the workspace usable', async t => {
  const f = await fixture(), runtime = new MipmuxRuntime(f.options), client = runtime.createClient(null);
  const spawn = runtime.supervisor.spawn.bind(runtime.supervisor), held: OwnedProcess[] = [];
  let armed = false, entered!: () => void; const holding = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(runtime.supervisor, 'spawn', (spec: ProcessSpec) => {
    if (armed && spec.executable === git && spec.args.includes('--numstat')) {
      const child = spawn({ ...spec, executable: process.execPath, args: [resolve('test/fixtures/held-git-read.mjs')] }); held.push(child);
      child.child.stderr.on('data', data => { if (data.toString().includes('MIPMUX_GIT_READ_HELD')) entered(); }); return child;
    }
    return spawn(spec);
  });
  try {
    const workspace = await client.declare(f.spec, signal()), controller = new AbortController();
    const input = gitValidator.Parse(gitValidator.Default({ op: 'diff', root: 'r', detail: 'full', maxOutputBytes: 100000 }));
    const initial = await client.explore(workspace.id, { name: 'git', input }, signal());
    assert('kind' in initial && initial.kind === 'git'); armed = true;
    const pending = client.explore(workspace.id, { name: 'git', input }, controller.signal);
    await holding; controller.abort(); await assert.rejects(pending, /cancelled|aborted/i);
    const joined = await Promise.all(held.map(child => child.closed)); assert.equal(joined.length, 1); armed = false;
    const usable = await client.explore(workspace.id, { name: 'git', input }, signal()); assert('kind' in usable && usable.kind === 'git');
    await writeFile('test-output/scout-diff-cancel-proof.json', JSON.stringify({ joined, usable }, null, 2) + '\n');
  } finally { await runtime.close(); }
});

test('public diff retains later chunk matches and follows the original stdin-error recovery predicate', async () => {
  const f = await fixture(), runtime = new MipmuxRuntime(f.options), client = runtime.createClient(null);
  const sourceChunkSize = 3000, sourceStdinThresholdBytes = 128 * 1024;
  const proof: unknown[] = [];
  try {
    const workspace = await client.declare(f.spec, signal());
    for (const longNames of [false, true]) {
      const paths = ['sub/file.swift', ...Array.from({ length: sourceChunkSize - 1 }, (_, index) =>
        'missing/' + index + (longNames ? 'x'.repeat(48) : '')), 'outside.swift'];
      const pathspecBytes = paths.reduce((count, path) => count + Buffer.byteLength(path) + 1, 0);
      assert.equal(pathspecBytes >= sourceStdinThresholdBytes, longNames);
      const input = gitValidator.Parse(gitValidator.Default({ op: 'diff', root: 'r', paths, detail: 'files', maxOutputBytes: 100000 }));
      if (longNames) {
        const probePath = join(f.base, 'probe-pathspecs');
        await writeFile(probePath, 'sub/file.swift\0outside.swift\0');
        const stdin = await open(probePath, 'r');
        try {
          // Git may reject the option before reading stdin; a file descriptor avoids a parent write racing that exit.
          const original = spawnSync(git, ['diff', '--name-status', '--no-ext-diff', '--color=never',
            '--pathspec-from-file=-', '--pathspec-file-nul', 'HEAD'], { cwd: f.repo, stdio: [stdin.fd, 'pipe', 'pipe'], encoding: 'utf8' });
          assert.equal(original.error, undefined);
          const sourceMessage = original.stderr.toLowerCase();
          const recovers = sourceMessage.includes('unknown option') || sourceMessage.includes('pathspec-from-file');
          if (original.status !== 0 && original.status !== 1 && !recovers) {
            await assert.rejects(client.explore(workspace.id, { name: 'git', input }, signal()), /gitQueryFailed/);
            proof.push({ pathspecCount: paths.length, pathspecBytes, sourceExit: original.status, recoveryAdmitted: false });
            continue;
          }
        } finally { await stdin.close(); }
      }
      const result = reply.Parse(await client.explore(workspace.id, { name: 'git', input }, signal()));
      assert.equal(result.kind, 'git', JSON.stringify(result));
      assert.deepEqual(result.diff?.files?.map(file => file.path), ['outside.swift', 'sub/file.swift']);
      proof.push({ pathspecCount: paths.length, pathspecBytes, result });
    }
    await writeFile('test-output/scout-diff-large-pathspec-proof.json', JSON.stringify(proof, null, 2) + '\n');
  } finally { await runtime.close(); }
});
