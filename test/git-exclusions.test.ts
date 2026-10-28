import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Compile } from 'typebox/compile';
import { GitResult } from '../src/contracts/git.js';
import type { InventorySnapshot } from '../src/contracts/inventory.js';
import { MipmuxRuntime, type RuntimeOptions } from '../src/runtime/mipmux-runtime.js';
import { copyContext } from './fixtures/copy-context.js';

const git = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;
const gitResult = Compile(GitResult);

/**
 * A repository whose tracked `AGENTS.md` and `.claude/cmds/tracked.md` match the user's excludes file, with untracked files
 * ignored only by that file or by the repository's `info/exclude`, and a `.gitconfig` under `home` naming the excludes file.
 */
async function fixture(globalConfig: string) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mipmux-git-exclusions-')));
  const home = join(base, 'home'), repo = join(base, 'repo'), out = join(base, 'out');
  await mkdir(home); await mkdir(out);
  await writeFile(join(home, '.gitconfig'), globalConfig);
  await writeFile(join(home, 'my-ignore'), 'AGENTS.md\nscratch/\n*.log\n.claude/\n');
  for (const directory of ['src', 'scratch', 'u', '.claude/cmds', 'sub/inner']) await mkdir(join(repo, directory), { recursive: true });
  const run = (args: string[]) => execFileSync(git, args, { cwd: repo, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-b', 'main']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  await appendFile(join(repo, '.git', 'info', 'exclude'), 'local-notes.txt\n');
  const files = { 'AGENTS.md': 'agents\n', 'src/kept.swift': 'struct Kept {}\n', '.claude/cmds/tracked.md': 'tracked\n',
    '.claude/untracked.md': 'untracked\n', 'scratch/x.txt': 'scratch\n', 'run.log': 'log\n', 'local-notes.txt': 'notes\n',
    'u/a.log': 'log\n', 'u/keep.txt': 'keep\n', 'sub/inner/deep.log': 'log\n', 'sub/inner/w.txt': 'w\n' };
  for (const [path, text] of Object.entries(files)) await writeFile(join(repo, path), text);
  run(['add', '-f', 'AGENTS.md', 'src/kept.swift', '.claude/cmds/tracked.md']); run(['commit', '-q', '-m', 'base']);
  const options: RuntimeOptions = { copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100,
    contextBudgetUnits: 1000000, credentialPaths: [], nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' },
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    git: { executable: git, userConfiguration: { home, xdgConfigHome: null } } };
  return { repo, out, options, run };
}

const filePaths = (snapshot: InventorySnapshot) => snapshot.entries.filter(entry => entry.kind === 'file').map(entry => entry.path).sort();

test('a refresh excludes untracked files that Git ignores and keeps tracked files that match the same patterns', async () => {
  const f = await fixture('[core]\n\texcludesFile = ~/my-ignore\n');
  const runtime = new MipmuxRuntime(f.options), client = runtime.createClient(null);
  try {
    const handle = await runtime.declare({ roots: [{ name: 'r', absolutePath: f.repo }], exclusions: [], outputRoot: f.out }, signal());
    const snapshot = await handle.refresh(signal());
    assert.deepEqual(filePaths(snapshot), ['.claude/cmds/tracked.md', 'AGENTS.md', 'src/kept.swift', 'sub/inner/w.txt', 'u/keep.txt']);
    // A wholly ignored directory is skipped without being listed.
    assert(snapshot.entries.some(entry => entry.kind === 'skipped' && entry.path === 'scratch'));
    assert(!snapshot.entries.some(entry => entry.path.startsWith('scratch/')));
    const operation = await handle.openOperation(signal());
    try {
      assert.equal((await operation.registerExplicitSource({ root: 'r', path: 'run.log' })).visibility, 'managedOnly');
    } finally { await operation.close(); }

    // Git's status lists the same untracked files.
    const { id } = await client.declare({ roots: [{ name: 'r', absolutePath: f.repo }], exclusions: [], outputRoot: f.out }, signal());
    const status = gitResult.Parse(await client.explore(id, { name: 'git', input: { op: 'status',
      repositories: [{ root: 'r', path: null, worktree: null }], maxOutputBytes: 100000 } }, signal()));
    assert(status.op === 'status' && 'status' in status);
    assert.deepEqual(status.status.untracked, ['sub/inner/w.txt', 'u/keep.txt']);

    f.run(['rm', '-q', '--cached', 'AGENTS.md']);
    assert(!filePaths(await handle.refresh(signal())).includes('AGENTS.md'), 'an untracked file that Git ignores was kept');

    const nested = await runtime.declare({ roots: [{ name: 'sub', absolutePath: join(f.repo, 'sub') }], exclusions: [], outputRoot: f.out }, signal());
    assert.deepEqual(filePaths(await nested.refresh(signal())), ['inner/w.txt']);
    await nested.close(); await handle.close();
  } finally { await client.close(); await runtime.close(); }
});

test('a root whose Git configuration cannot be read is reported as not enumerated', async () => {
  const f = await fixture('[core\n');
  const runtime = new MipmuxRuntime(f.options);
  try {
    const handle = await runtime.declare({ roots: [{ name: 'r', absolutePath: f.repo }], exclusions: [], outputRoot: f.out }, signal());
    const snapshot = await handle.refresh(signal());
    assert.deepEqual(snapshot.enumeration, { kind: 'incomplete', failures: [{ root: 'r', directory: { kind: 'root' }, code: 'gitConfigurationFailed' }] });
    await handle.close();
  } finally { await runtime.close(); }
});
