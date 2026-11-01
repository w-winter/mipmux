import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { InventorySnapshot } from '../src/contracts/inventory.js';
import { MipmuxRuntime } from '../src/runtime/mipmux-runtime.js';
import { copyContext } from './fixtures/copy-context.js';

const git = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;
const filePaths = (snapshot: InventorySnapshot) => snapshot.entries.filter(entry => entry.kind === 'file').map(entry => entry.path).sort();

test('.mipmux_ignore files leave paths out and bring back paths that other ignore files hide, below the .gitignore floor', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mipmux-ignore-')));
  const repo = join(base, 'repo'), out = join(base, 'out');
  await mkdir(out);
  await mkdir(repo);
  const run = (args: string[]) => execFileSync(git, args, { cwd: repo, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-b', 'main']);
  await appendFile(join(repo, '.git', 'info', 'exclude'), 'local/\n');
  const files = {
    '.gitignore': 'secret/\n', '.repo_ignore': 'docs/*\n', '.cursorignore': 'keep.md\n',
    '.mipmux_ignore': '!docs/investigations/\n!keep.md\n!local/\n!secret/\nnotes/\n',
    'docs/investigations/a.md': 'a\n', 'docs/plans/p.md': 'p\n', 'keep.md': 'keep\n', 'local/l.md': 'l\n', 'secret/s.md': 's\n',
    'notes/n.md': 'n\n', 'y.draft': 'y\n', 'sub/.mipmux_ignore': '*.draft\n', 'sub/x.draft': 'x\n', 'sub/x.md': 'x\n', 'src/main.ts': 'main\n' };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  const runtime = new MipmuxRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), terminationGraceMs: 100,
    contextBudgetUnits: 1000000, credentialPaths: [], nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' },
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), git: { executable: git } });
  try {
    const handle = await runtime.declare({ roots: [{ name: 'r', absolutePath: repo }], exclusions: [], outputRoot: out }, signal());
    // .mipmux_ignore outranks .repo_ignore, .cursorignore and Git's info/exclude, but never re-includes what .gitignore hides; a
    // nested .mipmux_ignore applies inside its own folder.
    assert.deepEqual(filePaths(await handle.refresh(signal())), ['.cursorignore', '.gitignore', '.mipmux_ignore', '.repo_ignore',
      'docs/investigations/a.md', 'keep.md', 'local/l.md', 'src/main.ts', 'sub/.mipmux_ignore', 'sub/x.md', 'y.draft']);
    // Edits apply at the next refresh, without restarting mipmux.
    await appendFile(join(repo, '.mipmux_ignore'), 'src/\n');
    assert(!filePaths(await handle.refresh(signal())).includes('src/main.ts'), 'an edited .mipmux_ignore was not applied');
    await handle.close();
  } finally { await runtime.close(); }
});
