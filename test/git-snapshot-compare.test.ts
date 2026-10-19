import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { BridgeClient, type NativeReply } from '../src/native/bridge-client.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';

const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;
const declaration = Compile(Type.Object({ kind: Type.Literal('workspace'), id: Type.String() }));
const result = Compile(Type.Object({ kind: Type.String(), code: Type.Optional(Type.String()), message: Type.Optional(Type.String()),
  diff: Type.Optional(Type.Object({ compare: Type.String() })) }));

test('public snapshot comparisons use only the saved HEAD, precede named refs and stay repository-scoped', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-snapshot-compare-')), output = join(base, 'out');
  await mkdir(output);
  const repos: { repo: string; first: string; tip: string }[] = [];
  const run = (repo: string, args: string[]) => execFileSync(git, args, { cwd: repo, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } });
  for (const name of ['a', 'b']) {
    const directory = join(base, name); await mkdir(join(directory, 'sub'), { recursive: true }); const repo = await realpath(directory);
    run(repo, ['init', '-q', '-b', 'main']); run(repo, ['config', 'user.name', 'Fixture']); run(repo, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(repo, 'sub/file.txt'), 'base ' + name + '\n'); await writeFile(join(repo, 'denied.txt'), 'protected base\n');
    run(repo, ['add', '.']); run(repo, ['commit', '-qm', 'first']); const first = run(repo, ['rev-parse', 'HEAD']).trim();
    await writeFile(join(repo, 'sub/file.txt'), 'tip ' + name + '\n'); run(repo, ['add', '.']); run(repo, ['commit', '-qm', 'tip']);
    const tip = run(repo, ['rev-parse', 'HEAD']).trim(); run(repo, ['branch', 'named']); run(repo, ['branch', 'only-ref']);
    await writeFile(join(repo, 'sub/file.txt'), 'worktree ' + name + '\n'); await writeFile(join(repo, 'denied.txt'), 'PROTECTED_SNAPSHOT_COMPARE_BODY\n');
    repos.push({ repo, first, tip });
  }
  const firstRepo = repos[0], secondRepo = repos[1]; assert(firstRepo && secondRepo);
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ supervisor, executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), env: {} });
  let repoKey: string;
  try {
    const opened = await bridge.request({ kind: 'openRoots', roots: [{ name: 'out', absolutePath: output, access: 'output', expected: null }] }, signal());
    const root = opened.result.roots[0]; assert(root);
    const target = await bridge.request({ kind: 'electGitTarget', roots: [{ name: 'a', path: firstRepo.repo }],
      paths: [join(firstRepo.repo, 'sub/file.txt')] }, signal());
    assert(target.result.state === 'available'); repoKey = target.result.primary.repoKey;
    for (const snapshotID of ['named', 'main', '2026-10-14/1000']) {
      const snapshot: NativeReply<'beginGitSnapshot'> = await bridge.request({ kind: 'beginGitSnapshot', root: root.handle, repoKey, snapshotID }, signal());
      const rendered = await bridge.request({ kind: 'serializeGitSnapshot', input: { snapshotID, repoKey, mode: 'quick', scope: 'selected',
        requestedPaths: ['irrelevant'], compare: 'staged:DO_NOT_REUSE_BASE', compareInput: 'stored', diffText: 'DO_NOT_REUSE_PATCH', perFile: null,
        changedFiles: [], summary: { files: 0, insertions: 0, deletions: 0 }, fingerprint: { headSHA: firstRepo.first,
          baseRef: 'DO_NOT_REUSE_BASE', statusHash: 'historic', generatedAt: '2026-10-14T10:00:00Z' }, contextLines: 3,
        detectRenames: false, commitGraph: '', repoRoot: firstRepo.repo, tabID: null, worktree: null } }, signal());
      for (const file of rendered.result.files) await bridge.request({ kind: 'writeGitSnapshotFile', run: snapshot.result.run, path: file.path, bytes: file.bytes }, signal());
      if (snapshotID === 'named') await bridge.request({ kind: 'writeGitSnapshotCurrent', run: snapshot.result.run }, signal());
    }
  } finally { await bridge.close(); await supervisor.close(); }
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, terminationGraceMs: 100,
    credentialPaths: repos.map(entry => join(entry.repo, 'denied.txt')), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, git: { executable: git }, discovery: null, defaultMaxOutputBytes: 100000 }));
  const client = new Client({ name: 'snapshot-compare', version: '1' }), proof: unknown[] = [];
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const index = await readFile(join(firstRepo.repo, '.git/index'));
  try {
    await client.connect(transport);
    const workspace = declaration.Parse((await client.callTool({ name: 'workspace_declare', arguments: { spec: {
      roots: [{ name: 'a', absolutePath: join(firstRepo.repo, 'sub') }, { name: 'b', absolutePath: secondRepo.repo }], exclusions: [], outputRoot: output } } })).structuredContent);
    const call = async (compare: string, root = 'a') => {
      const response = await client.callTool({ name: 'git', arguments: { workspaceId: workspace.id,
        input: { op: 'diff', root, compare, detail: 'full' }, maxOutputBytes: 100000 } });
      proof.push(response); return { parsed: result.Parse(response.structuredContent), response };
    };
    for (const compare of ['last', ' LAST ', 'named', '2026-10-14/1000']) {
      const { parsed, response } = await call(compare); assert.equal(parsed.kind, 'git', JSON.stringify(parsed));
      assert.equal(parsed.diff?.compare, 'uncommitted:' + firstRepo.first);
      const text = JSON.stringify(response); assert(text.includes('-base a')); assert(text.includes('+worktree a'));
      assert(!text.includes('PROTECTED_SNAPSHOT_COMPARE_BODY')); assert(!text.includes('DO_NOT_REUSE'));
    }
    assert.equal((await call('last', 'b')).parsed.code, 'gitSnapshotUnavailable');
    assert.equal((await call('2026-10-14/9999-2')).parsed.code, 'gitSnapshotNotFound');
    const missingCurrent = (await call('last', 'b')).parsed; assert(missingCurrent.message?.includes('No CURRENT snapshot'));
    assert.equal((await call('only-ref')).parsed.diff?.compare, 'only-ref');
    assert.equal((await call('main')).parsed.diff?.compare, 'mergebase:main');
    await writeFile(join(output, '_git_data/repos', repoKey, 'named/manifest.json'), '{not a manifest');
    assert.equal((await call('named')).parsed.diff?.compare, 'named');
    const unreadable = (await call('last')).parsed;
    assert.equal(unreadable.code, 'gitSnapshotManifestUnavailable'); assert(unreadable.message?.includes('Unable to read CURRENT snapshot manifest'));
    await writeFile(join(output, '_git_data/repos', repoKey, '2026-10-14/1000/manifest.json'), '{not a manifest');
    assert.equal((await call('2026-10-14/1000')).parsed.code, 'gitSnapshotNotFound');
    assert.deepEqual(await readFile(join(firstRepo.repo, '.git/index')), index);
    await writeFile('test-output/git-snapshot-compare-mcp-proof.json', JSON.stringify({ proof, indexUnchanged: true }, null, 2) + '\n');
  } finally { await client.close(); }
});
