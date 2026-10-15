import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import type { OwnedProcess, ProcessSpec } from '../src/runtime/process-supervisor.js';
const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const nativeExecutable = resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`);
const declaration = Compile(Type.Object({ kind: Type.Literal('workspace'), id: Type.String() }));
const reply = Compile(Type.Object({ kind: Type.String(), code: Type.Optional(Type.String()), message: Type.Optional(Type.String()),
  exclusions: Type.Optional(Type.Array(Type.String())), show: Type.Optional(Type.Object({
  sha: Type.String(), short_sha: Type.String(), author: Type.String(), date: Type.String(), message: Type.String(),
  totals: Type.Object({ files: Type.Integer(), insertions: Type.Integer(), deletions: Type.Integer() }),
  files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), status: Type.String(), insertions: Type.Optional(Type.Integer()),
    deletions: Type.Optional(Type.Integer()), hunks: Type.Optional(Type.Array(Type.Object({ header: Type.String(), old_start: Type.Integer(),
      new_start: Type.Integer(), patch: Type.String() }))) }))) })) }));
async function fixture() {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-git-show-')), repo = join(base, 'repo'), root = join(repo, 'sub');
  await mkdir(root, { recursive: true }); await mkdir(join(base, 'out'));
  const run = (args: string[]) => execFileSync(git, args, { cwd: repo, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: base,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: '2026-10-11T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-11T10:00:00Z' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'file.txt'), 'one\ntwo\n'); run(['add', '--', 'sub/file.txt']); run(['commit', '-qm', 'first']);
  const first = run(['rev-parse', 'HEAD']).trim();
  await writeFile(join(root, 'file.txt'), 'one\ntwo\nthree\n'); run(['add', '--', 'sub/file.txt']); run(['commit', '-qm', 'second\n\nComplete body.']);
  const second = run(['rev-parse', 'HEAD']).trim();
  const options = { cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable, nativeEnvironment: {}, git: { executable: git } };
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: join(base, 'out') };
  return { base, repo, root, first, second, options, spec, run };
}
test('public show preserves metadata, full hunks, root-commit source behavior and safe revision arguments through MCP', async () => {
  const f = await fixture(), marker = join(f.base, 'converter-ran'), outputFile = join(f.base, 'injected-output');
  await writeFile(join(f.repo, '.gitattributes'), 'sub/file.txt diff=fixture\n');
  f.run(['config', 'diff.fixture.textconv', `"${process.execPath}" "${resolve('test/fixtures/git-textconv-probe.mjs')}" "${marker}"`]);
  await writeFile(join(f.root, 'file.txt'), 'one\ntwo\nthree\nworktree\n');
  const before = await readFile(join(f.repo, '.git/index')), config = join(f.base, 'config.json');
  await writeFile(config, JSON.stringify({ ...f.options, discovery: null, defaultMaxOutputBytes: 24000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'git-show-source', version: '1' }), proof: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = declaration.Parse((await client.callTool({ name: 'workspace_declare', arguments: { spec: f.spec } })).structuredContent);
    const call = async (ref: string, detail = 'summary', maxOutputBytes = 24000) => {
      const result = await client.callTool({ name: 'git', arguments: { workspaceId: workspace.id,
        input: { op: 'show', root: 'r', ref, detail }, maxOutputBytes } });
      proof.push(result); return { response: result, value: reply.Parse(result.structuredContent) };
    };
    const summary = await call('  HEAD  '); assert.equal(summary.response.isError, false, JSON.stringify(summary.response));
    assert(summary.value.show); assert.equal(summary.value.show.sha, f.second);
    assert.equal(summary.value.show.message, 'second\n\nComplete body.');
    assert.deepEqual(summary.value.show.totals, { files: 1, insertions: 1, deletions: 0 });
    assert.equal(summary.value.show.files, undefined);
    const files = await call(f.second, 'files'); assert(files.value.show?.files);
    assert.deepEqual(files.value.show.files, [{ path: 'sub/file.txt', status: 'M', insertions: 1, deletions: 0 }]);
    const full = await call(f.second, 'FULL'); assert(full.value.show?.files?.[0]?.hunks?.[0]);
    assert.equal(full.value.show.files[0].hunks[0].header, '@@ -1,2 +1,3 @@');
    assert.equal(full.value.show.files[0].hunks[0].patch, ' one\n two\n+three\n');
    const patches = await call(f.second, 'patches'); assert.deepEqual(patches.value.show, full.value.show);
    const rootCommit = await call(f.first, 'full'); assert(rootCommit.value.show);
    assert.deepEqual(rootCommit.value.show.totals, { files: 1, insertions: 2, deletions: 0 });
    assert(rootCommit.value.show.files?.[0]?.hunks?.[0]?.patch.includes('+worktree'));
    assert.equal((await call(f.second, 'full', 1)).value.kind, 'outputBudgetTooSmall');
    assert.equal((await call('does-not-exist')).value.code, 'gitQueryFailed');
    assert.equal((await call('--output=' + outputFile)).value.code, 'gitQueryFailed');
    assert.equal(existsSync(outputFile), false); assert.equal(existsSync(marker), false);
    assert.deepEqual(await readFile(join(f.repo, '.git/index')), before);
    await writeFile(join(f.base, 'mcp-receipt.json'), JSON.stringify({ proof, indexUnchanged: true, converterExecuted: false, argumentInjection: false }, null, 2) + '\n');
  } finally { await client.close(); }
});
test('cancelling show between Git phases joins its process and preserves workspace usability', async t => {
  const f = await fixture(), runtime = new SmipRuntime(f.options), client = runtime.createClient(null);
  const spawn = runtime.supervisor.spawn.bind(runtime.supervisor), held: OwnedProcess[] = [];
  let armed = false, entered!: () => void;
  const holding = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(runtime.supervisor, 'spawn', (spec: ProcessSpec) => {
    if (armed && spec.executable === git && spec.args.includes('--numstat')) {
      const child = spawn({ ...spec, executable: process.execPath, args: [resolve('test/fixtures/held-git-read.mjs')] }); held.push(child);
      child.child.stderr.on('data', data => { if (data.toString().includes('SMIP_GIT_READ_HELD')) entered(); }); return child;
    }
    return spawn(spec);
  });
  try {
    const workspace = await client.declare(f.spec, new AbortController().signal), controller = new AbortController();
    const input = { op: 'show' as const, root: 'r', ref: 'HEAD', detail: 'full', contextLines: 3, detectRenames: false, maxOutputBytes: 24000 };
    const initial = await client.explore(workspace.id, { name: 'git', input }, new AbortController().signal);
    assert('kind' in initial && initial.kind === 'git'); armed = true;
    const pending = client.explore(workspace.id, { name: 'git', input }, controller.signal);
    await holding; controller.abort(); await assert.rejects(pending, /cancelled|aborted/i);
    const joined = await Promise.all(held.map(child => child.closed)); assert.equal(joined.length, 1); armed = false;
    const usable = await client.explore(workspace.id, { name: 'git', input }, new AbortController().signal);
    assert('kind' in usable && usable.kind === 'git');
    await writeFile(join(f.base, 'cancel-receipt.json'), JSON.stringify({ joined, usable }, null, 2) + '\n');
  } finally { await runtime.close(); }
});

test('public show excludes protected files and both protected rename endpoints while retaining authorized checkout evidence', async () => {
  const f = await fixture(), credential = join(f.repo, 'credential.txt');
  await writeFile(credential, 'PROTECTED_SHOW_FIXTURE\n');
  await writeFile(join(f.root, 'skip.txt'), 'EXCLUDED_SHOW_FIXTURE\n');
  await writeFile(join(f.repo, 'safe-outside.txt'), 'authorized checkout evidence\n');
  f.run(['add', '--', 'credential.txt', 'sub/skip.txt', 'safe-outside.txt']); f.run(['commit', '-qm', 'scoped evidence']);
  const evidence = f.run(['rev-parse', 'HEAD']).trim();
  f.run(['mv', '--', 'credential.txt', 'exposed.txt']); f.run(['commit', '-qm', 'rename protected source']);
  const renamed = f.run(['rev-parse', 'HEAD']).trim(), index = await readFile(join(f.repo, '.git/index'));
  const config = join(f.base, 'protected-config.json');
  await writeFile(config, JSON.stringify({ ...f.options, credentialPaths: [credential], discovery: null, defaultMaxOutputBytes: 24000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'protected-show', version: '1' }), proof: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = declaration.Parse((await client.callTool({ name: 'workspace_declare', arguments: { spec: { ...f.spec,
      exclusions: [{ kind: 'prefix', root: 'r', path: 'skip.txt' }] } } })).structuredContent);
    const call = async (ref: string, detail: string) => {
      const result = await client.callTool({ name: 'git', arguments: { workspaceId: workspace.id,
        input: { op: 'show', root: 'r', ref, detail, detectRenames: true } } });
      assert.equal(result.isError, false, JSON.stringify(result)); proof.push(result); return reply.Parse(result.structuredContent);
    };
    const full = await call(evidence, 'full'); assert(full.show?.files);
    assert(!JSON.stringify(full).includes('PROTECTED_SHOW_FIXTURE')); assert(!JSON.stringify(full).includes('EXCLUDED_SHOW_FIXTURE'));
    assert.deepEqual(full.show.files.map(file => file.path), ['safe-outside.txt']);
    assert.deepEqual(full.show.totals, { files: 1, insertions: 1, deletions: 0 });
    assert(full.exclusions?.includes('credential.txt')); assert(full.exclusions?.includes('sub/skip.txt'));
    const summary = await call(evidence, 'summary'); assert.deepEqual(summary.show?.totals, full.show.totals);
    const rename = await call(renamed, 'full'); assert(!JSON.stringify(rename).includes('PROTECTED_SHOW_FIXTURE'));
    assert(rename.exclusions?.includes('credential.txt')); assert(rename.exclusions?.includes('exposed.txt'));
    assert.deepEqual(rename.show?.totals, { files: 0, insertions: 0, deletions: 0 });
    assert.deepEqual(await readFile(join(f.repo, '.git/index')), index);
    await writeFile('test-output/git-show-protected-proof.json', JSON.stringify({ proof, indexUnchanged: true }, null, 2) + '\n');
  } finally { await client.close(); }
});

test('malformed show metadata stops before subsequent diff commands', async t => {
  const f = await fixture(), runtime = new SmipRuntime(f.options), client = runtime.createClient(null);
  const spawn = runtime.supervisor.spawn.bind(runtime.supervisor);
  let diffCommands = 0;
  t.mock.method(runtime.supervisor, 'spawn', (spec: ProcessSpec) => {
    if (spec.executable === git && spec.args.includes('show')) {
      return spawn({ ...spec, executable: process.execPath, args: [resolve('test/fixtures/git-malformed-show.mjs')] });
    }
    if (spec.executable === git && spec.args.includes('diff')) diffCommands++;
    return spawn(spec);
  });
  try {
    const workspace = await client.declare(f.spec, new AbortController().signal);
    await assert.rejects(client.explore(workspace.id, { name: 'git', input: { op: 'show', root: 'r', ref: 'HEAD',
      detail: 'full', contextLines: 3, detectRenames: false, maxOutputBytes: 24000 } }, new AbortController().signal), /gitShowMalformed/);
    assert.equal(diffCommands, 0);
    await writeFile(join(f.base, 'malformed-receipt.json'), JSON.stringify({ diffCommands }) + '\n');
  } finally { await runtime.close(); }
});

test('public MCP retains source diagnostics for malformed Git show and status outputs', async () => {
  const f = await fixture(), executable = join(f.base, 'malformed-git');
  await writeFile(executable, '#!' + process.execPath + '\n' +
    'import {spawnSync} from "node:child_process"; const args=process.argv.slice(2); ' +
    'if(args.includes("show")) process.stdout.write("malformed commit metadata\\n"); ' +
    'else if(args.includes("status")) process.stdout.write("invalid record\\0"); ' +
    'else { const child=spawnSync(' + JSON.stringify(git) + ', args, {stdio:"inherit"}); process.exit(child.status ?? 1); }\n');
  await chmod(executable, 0o700);
  const config = join(f.base, 'config.json');
  await writeFile(config, JSON.stringify({ ...f.options, git: { executable }, discovery: null, defaultMaxOutputBytes: 24000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'git-diagnostics-source', version: '1' }), proof: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = declaration.Parse((await client.callTool({ name: 'workspace_declare', arguments: { spec: f.spec } })).structuredContent);
    for (const input of [{ op: 'show', root: 'r', ref: 'HEAD' }, { op: 'status', root: 'r' }]) {
      const result = await client.callTool({ name: 'git', arguments: { workspaceId: workspace.id, input } });
      assert.equal(result.isError, true);
      const value = reply.Parse(result.structuredContent);
      assert.equal(value.code, input.op === 'show' ? 'gitShowMalformed' : 'gitStatusMalformed');
      if (input.op === 'show') assert.equal(value.message, 'Unexpected git show output format');
      else assert.equal(value.message, 'Failed to parse VCS output: unsupported porcelain-v2 record type: i');
      proof.push(result);
    }
    await writeFile(join(f.base, 'diagnostics-mcp-receipt.json'), JSON.stringify(proof, null, 2) + '\n');
  } finally { await client.close(); }
});
