import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type, { type Static } from 'typebox';
import type { GitInput } from '../src/contracts/git.js';
import { Compile } from 'typebox/compile';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import type { OwnedProcess, ProcessSpec } from '../src/runtime/process-supervisor.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';

const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;
const nativeExecutable = resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`);
const declaration = Compile(Type.Object({ kind: Type.Literal('workspace'), id: Type.String() }));
const result = Compile(Type.Object({ kind: Type.String(), code: Type.Optional(Type.String()), root: Type.Optional(Type.String()),
  op: Type.Optional(Type.String()), status: Type.Optional(Type.Object({ branch: Type.Optional(Type.String()),
    upstream: Type.Optional(Type.String()), ahead: Type.Optional(Type.Integer()), behind: Type.Optional(Type.Integer()),
    staged: Type.Array(Type.String()), modified: Type.Array(Type.String()), untracked: Type.Array(Type.String()), summary: Type.String() })), log: Type.Optional(Type.Object({ commits: Type.Array(Type.Object({ sha: Type.String(),
    short_sha: Type.String(), author: Type.String(), date: Type.String(), message: Type.String(), files_changed: Type.Integer(),
    insertions: Type.Integer(), deletions: Type.Integer() })) })),
  blame: Type.Optional(Type.Object({ path: Type.String(), lines: Type.Array(Type.Object({ num: Type.Integer(), sha: Type.String(),
    author: Type.String(), date: Type.String(), content: Type.String() })) })) }));

async function fixture() {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-git-read-'));
  const repo = join(base, 'repo'), root = join(repo, 'sub'), outputRoot = join(base, 'out');
  await mkdir(root, { recursive: true }); await mkdir(outputRoot);
  const run = (args: string[]) => execFileSync(git, args, { cwd: repo, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_DATE: '2026-10-11T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-11T10:00:00Z' }, stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'file.txt'), 'one é\ntwo\n'); await writeFile(join(root, 'protected.txt'), 'synthetic protected content\n');
  run(['add', '--', 'sub/file.txt', 'sub/protected.txt']); run(['commit', '-m', 'first']);
  const first = run(['rev-parse', 'HEAD']).trim();
  await writeFile(join(root, 'file.txt'), 'one é\ntwo\nthree\n');
  run(['add', '--', 'sub/file.txt']); run(['commit', '-m', 'second']);
  const second = run(['rev-parse', 'HEAD']).trim();
  const options = { cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000,
    credentialPaths: [join(root, 'protected.txt')], nativeExecutable, nativeEnvironment: {}, git: { executable: git } };
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot };
  return { base, repo, root, first, second, options, spec, run };
}

test('public Git log/blame use the nearest owning checkout, retain source fields, enforce path policy and remain read-only', async () => {
  const f = await fixture();
  const converterMarker = join(f.base, 'converter-ran');
  await writeFile(join(f.repo, '.gitattributes'), 'sub/file.txt diff=fixture\n');
  f.run(['config', 'diff.fixture.textconv',
    `"${process.execPath}" "${resolve('test/fixtures/git-textconv-probe.mjs')}" "${converterMarker}"`]);
  const before = await readFile(join(f.repo, '.git/index'));
  const config = join(f.base, 'config.json');
  await writeFile(config, JSON.stringify({ ...f.options, search: null, discovery: null, defaultMaxOutputBytes: 24000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'git-source', version: '1' });
  const proof: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = declaration.Parse((await client.callTool({ name: 'workspace_declare', arguments: { spec: f.spec } })).structuredContent);
    const call = async (input: Static<typeof GitInput>, maxOutputBytes = 24000) => {
      const reply = await client.callTool({ name: 'git', arguments: { workspaceId: workspace.id, input, maxOutputBytes } });
      proof.push({ input, result: reply }); return { reply, value: result.Parse(reply.structuredContent) };
    };
    const log = await call({ op: 'log', root: 'r' });
    assert.equal(log.reply.isError, false, JSON.stringify(log.reply));
    assert.equal(log.value.kind, 'git'); assert.equal(log.value.root, 'r'); assert(log.value.log);
    assert.deepEqual(log.value.log.commits.map(row => row.sha), [f.second, f.first]);
    assert.deepEqual(log.value.log.commits.map(row => [row.message, row.files_changed, row.insertions, row.deletions]), [
      ['second', 1, 1, 0], ['first', 2, 3, 0],
    ]);
    const limited = await call({ op: 'log', root: 'r', count: 1, path: 'file.txt' });
    assert.deepEqual(limited.value.log?.commits.map(row => row.sha), [f.second]);
    const blame = await call({ op: 'blame', root: 'r', path: 'file.txt', lines: '2 - 3' });
    assert.equal(blame.reply.isError, false, JSON.stringify(blame.reply)); assert(blame.value.blame);
    assert.deepEqual(blame.value.blame.lines.map(row => [row.num, row.sha, row.author, row.date, row.content]), [
      [2, f.first.slice(0, 7), 'Fixture', '2026-10-11T10:00:00Z', 'two'],
      [3, f.second.slice(0, 7), 'Fixture', '2026-10-11T10:00:00Z', 'three'],
    ]);
    assert.equal(existsSync(converterMarker), false, 'Read-only blame must not execute a repository converter');
    const cap = await call({ op: 'log', root: 'r' }, 1); assert.equal(cap.value.kind, 'outputBudgetTooSmall');
    const protectedPath = await call({ op: 'blame', root: 'r', path: 'protected.txt' });
    assert.equal(protectedPath.reply.isError, true); assert.equal(protectedPath.value.code, 'pathDenied');
    const failure = await call({ op: 'blame', root: 'r', path: 'missing.txt' });
    assert.equal(failure.reply.isError, true); assert.equal(failure.value.code, 'gitQueryFailed');
    const foreign = await call({ op: 'log', root: 'foreign' });
    assert.equal(foreign.reply.isError, true); assert.equal(foreign.value.code, 'unknownRoot');
    assert.deepEqual(await readFile(join(f.repo, '.git/index')), before);
    assert(!JSON.stringify(proof).includes('synthetic protected content'));
    await writeFile(join(f.base, 'mcp-receipt.json'), JSON.stringify({ proof, converterExecuted: false }, null, 2) + '\n');
  } finally { await client.close(); }
});

test('real scripted SDK scout can inspect Git through the allowed tool boundary and publish without app access', async () => {
  const f = await fixture();
  const provider = await scriptedProvider((_summary, index) => index === 1
    ? { kind: 'tool', name: 'git', input: { op: 'status', root: 'r', maxOutputBytes: 24000 }, stop: 'tool_use', tokens: 10 }
    : index === 2 ? { kind: 'tool', name: 'git', input: { op: 'log', root: 'r', count: 1, maxOutputBytes: 24000 }, stop: 'tool_use', tokens: 10 }
    : index === 3 ? { kind: 'tool', name: 'git', input: { op: 'blame', root: 'r', path: 'file.txt', lines: '1-2', maxOutputBytes: 24000 }, stop: 'tool_use', tokens: 10 }
    : index === 4 ? { kind: 'tool', name: 'git', input: { op: 'show', root: 'r', ref: 'HEAD', detail: 'full', maxOutputBytes: 24000 }, stop: 'tool_use', tokens: 10 }
    : { kind: 'text', text: 'complete', stop: 'end_turn', tokens: 10 });
  const runtime = new SmipRuntime(f.options), client = runtime.createClient(new PiRunner(provider.config, runtime.supervisor));
  try {
    const workspace = await client.declare(f.spec, signal());
    const job = client.build(workspace.id, 'git-scout', { task: 'Inspect history', copyPreset: 'standard' as const, storedPrompts: [], constraints: '', purpose: 'investigation', enhancementMode: 'preserve',
      requiredSources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } }], documents: [], patches: [], discoveryHints: [], budgetUnits: 10000, outputName: 'packet' });
    const terminal = await client.wait(job.jobId, 10000, signal(), () => {});
    assert.equal(terminal.state, 'ready', JSON.stringify(terminal)); assert.equal(terminal.localSettled, true);
    assert(provider.requests.every(request => request.tools.includes('git')));
    const returned = JSON.stringify(provider.requests.at(-1)?.messages);
    assert(returned.includes('second')); assert(returned.includes('one é')); assert(returned.includes('status'));
    assert(!returned.includes('Invalid arguments'), 'The scout status request must pass the real tool schema');
    await writeFile(join(f.base, 'sdk-receipt.json'), JSON.stringify({ terminal, requests: provider.requests }, null, 2) + '\n');
  } finally { await runtime.close(); await provider.close(); }
});

test('cancelling a held Git process joins it and leaves the workspace usable', async t => {
  const f = await fixture(), runtime = new SmipRuntime(f.options), client = runtime.createClient(null);
  const spawn = runtime.supervisor.spawn.bind(runtime.supervisor);
  const held: OwnedProcess[] = [];
  let armed = false, entered!: () => void;
  const holding = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(runtime.supervisor, 'spawn', (spec: ProcessSpec) => {
    if (armed && spec.executable === git && spec.args.includes('log')) {
      const process = spawn({ ...spec, executable: globalThis.process.execPath, args: [resolve('test/fixtures/held-git-read.mjs')] });
      held.push(process);
      process.child.stderr.on('data', data => { if (data.toString().includes('SMIP_GIT_READ_HELD')) entered(); });
      return process;
    }
    return spawn(spec);
  });
  try {
    const workspace = await client.declare(f.spec, signal()), controller = new AbortController();
    const query = { op: 'log' as const, root: 'r', count: 1, path: null, maxOutputBytes: 24000 };
    const initial = await client.explore(workspace.id, { name: 'git', input: query }, signal());
    assert.equal(initial?.kind, 'git');
    armed = true;
    const pending = client.explore(workspace.id, { name: 'git', input: query }, controller.signal);
    await holding; controller.abort(); await assert.rejects(pending, /aborted|cancelled/i);
    const joined = await Promise.all(held.map(process => process.closed)); assert.equal(joined.length, 1);
    armed = false;
    const usable = await client.explore(workspace.id, { name: 'git', input: query }, signal());
    assert.equal(usable.kind, 'git');
    await writeFile(join(f.base, 'cancel-receipt.json'), JSON.stringify({ joined, usable }, null, 2) + '\n');
  } finally { await runtime.close(); }
});

test('public Git status returns coherent source categories for a subdirectory root without changing the index or running fsmonitor', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'rename-me.txt'), 'unique rename evidence\n');
  await writeFile(join(f.root, 'delete-me.txt'), 'unique deletion evidence\n');
  f.run(['add', '--', 'sub/rename-me.txt', 'sub/delete-me.txt']); f.run(['commit', '-m', 'status base']);
  const branch = f.run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  await writeFile(join(f.root, 'file.txt'), 'staged modification\n'); f.run(['add', '--', 'sub/file.txt']);
  await writeFile(join(f.root, 'file.txt'), 'staged modification\nthen worktree modification\n');
  await rename(join(f.root, 'rename-me.txt'), join(f.root, 'Renamed file.txt'));
  await rename(join(f.root, 'delete-me.txt'), join(f.base, 'saved-deleted.txt'));
  f.run(['add', '--', 'sub/rename-me.txt', 'sub/Renamed file.txt', 'sub/delete-me.txt']);
  const unusual = 'untracked é\tline\n.txt';
  await writeFile(join(f.root, unusual), 'untracked body\n');
  await writeFile(join(f.repo, 'outside-root.txt'), 'outside-root body\n');
  const fsmonitorMarker = join(f.base, 'fsmonitor-ran');
  f.run(['config', 'core.fsmonitor',
    '"' + process.execPath + '" "' + resolve('test/fixtures/git-fsmonitor-probe.mjs') + '" "' + fsmonitorMarker + '"']);
  const before = await readFile(join(f.repo, '.git/index'));
  const config = join(f.base, 'config.json');
  await writeFile(config, JSON.stringify({ ...f.options, search: null, discovery: null, defaultMaxOutputBytes: 24000 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'git-status-source', version: '1' });
  try {
    await client.connect(transport);
    const workspace = declaration.Parse((await client.callTool({ name: 'workspace_declare', arguments: { spec: f.spec } })).structuredContent);
    const reply = await client.callTool({ name: 'git', arguments: { workspaceId: workspace.id, input: { op: 'status', root: 'r' } } });
    assert.equal(reply.isError, false, JSON.stringify(reply));
    const value = result.Parse(reply.structuredContent);
    assert.equal(value.kind, 'git'); assert.equal(value.op, 'status'); assert(value.status);
    assert.equal(value.status.branch, branch);
    assert.deepEqual(value.status.staged, ['sub/Renamed file.txt', 'sub/delete-me.txt', 'sub/file.txt']);
    assert.deepEqual(value.status.modified, ['sub/file.txt']);
    assert.deepEqual(value.status.untracked, ['outside-root.txt', 'sub/' + unusual]);
    assert.equal(value.status.summary, branch + ' | 3 staged, 1 modified, 2 untracked');
    assert.equal(value.status.upstream, undefined); assert.equal(value.status.ahead, undefined); assert.equal(value.status.behind, undefined);
    const cap = result.Parse((await client.callTool({ name: 'git', arguments: { workspaceId: workspace.id,
      input: { op: 'status', root: 'r' }, maxOutputBytes: 1 } })).structuredContent);
    assert.equal(cap.kind, 'outputBudgetTooSmall');
    assert.deepEqual(await readFile(join(f.repo, '.git/index')), before);
    assert.equal(existsSync(fsmonitorMarker), false, 'Status must not execute a repository fsmonitor hook');
    await writeFile(join(f.base, 'status-mcp-receipt.json'), JSON.stringify({ reply, cap, fsmonitorExecuted: false, indexUnchanged: true }, null, 2) + '\n');
  } finally { await client.close(); }
});
