import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Compile } from 'typebox/compile';
import Type, { type Static } from 'typebox';
import { GitResult, type GitInput } from '../src/contracts/git.js';
import { MipmuxRuntime } from '../src/runtime/mipmux-runtime.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { copyContext } from './fixtures/copy-context.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import type { OwnedProcess, ProcessSpec } from '../src/runtime/process-supervisor.js';
import { toolJSON } from './fixtures/tool-json.js';

const git = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;
const result = Compile(GitResult);
const workspaceResult = Compile(Type.Object({ id: Type.String() }));

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mipmux-git-routing-')));
  const a = join(base, 'a'), b = join(base, 'b'), linked = join(base, 'linked'), out = join(base, 'out');
  await mkdir(a); await mkdir(b); await mkdir(out);
  const run = (cwd: string, args: string[]) => execFileSync(git, args, { cwd, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  for (const [cwd, label] of [[a, 'ALPHA'], [b, 'BETA']]) {
    assert(cwd && label);
    run(cwd, ['init', '-b', 'main']); run(cwd, ['config', 'user.name', 'Fixture']);
    run(cwd, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(cwd, 'file.txt'), label + '\n');
    await writeFile(join(cwd, 'protected.txt'), 'synthetic private evidence\n');
    run(cwd, ['add', '.']); run(cwd, ['commit', '-m', label]);
    await writeFile(join(cwd, 'file.txt'), label + '\nchanged\n');
  }
  run(a, ['worktree', 'add', '-b', 'topic', linked]);
  await writeFile(join(linked, 'file.txt'), 'LINKED\n'); run(linked, ['add', 'file.txt']);
  run(linked, ['commit', '-m', 'LINKED']);
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000,
    terminationGraceMs: 100, credentialPaths: [join(a, 'protected.txt')],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, git: { executable: git } };
  const spec = { roots: [{ name: 'a', absolutePath: a }, { name: 'b', absolutePath: b }], exclusions: [], outputRoot: out };
  return { base, a, b, linked, options, spec, run };
}

test('MCP Git reads route ordered repositories and linked checkouts with primary warnings and expected status failures', async () => {
  const f = await fixture(), config = join(f.base, 'config.json');
  const nested = join(f.a, 'nested'), nestedLinked = join(f.base, 'nested-linked');
  await mkdir(nested); f.run(nested, ['init', '-b', 'main']);
  f.run(nested, ['config', 'user.name', 'Fixture']); f.run(nested, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(nested, 'nested.txt'), 'NESTED\n'); f.run(nested, ['add', '.']); f.run(nested, ['commit', '-m', 'NESTED']);
  f.run(nested, ['worktree', 'add', '-b', 'nested-topic', nestedLinked]);
  await writeFile(config, JSON.stringify({ ...f.options, discovery: null, defaultMaxOutputBytes: 100000 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/main.js'), 'mcp', '--tools', 'full', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'git-routing', version: '1' }), proof: unknown[] = [];
  try {
    await client.connect(transport);
    const workspace = workspaceResult.Parse(toolJSON(await client.callTool({ name: 'workspace_declare', arguments: { spec: f.spec } })));
    const call = async (input: Static<typeof GitInput>, maxOutputBytes = 100000) => {
      const reply = await client.callTool({ name: 'git', arguments: { workspaceId: workspace.id, input, maxOutputBytes } });
      proof.push({ input, reply }); return reply;
    };
    const nestedReply = await call({ op: 'log', repositories: [{ root: 'a', path: 'nested', worktree: nestedLinked }] });
    assert.equal(nestedReply.isError, false, JSON.stringify(nestedReply));
    const nestedValue = result.Parse(toolJSON(nestedReply));
    assert(nestedValue.op === 'log' && nestedValue.worktree);
    assert.equal(await realpath(nestedValue.worktree.worktree_root), nestedLinked);
    assert(nestedValue.log.commits.some(commit => commit.message === 'NESTED'));
    const repositories = [{ root: 'b' }, { root: 'a' }, { root: 'b' }];
    const multi = await call({ op: 'status', repositories });
    assert.equal(multi.isError, false, JSON.stringify(multi));
    const value = result.Parse(toolJSON(multi));
    assert(value.op === 'status' && 'repos' in value);
    assert.deepEqual(value.repos.map(repo => repo.root), ['b', 'a']);
    assert(value.repos.every(repo => 'status' in repo && repo.status.modified.includes('file.txt')));
    const historyInputs: Static<typeof GitInput>[] = [{ op: 'log', repositories }, { op: 'show', repositories, ref: 'HEAD' },
      { op: 'blame', repositories, path: 'file.txt' }];
    for (const input of historyInputs) {
      const reply = result.Parse(toolJSON(await call(input)));
      assert('root' in reply && reply.root === 'b');
      assert('warning' in reply && reply.warning?.includes('Multiple repos detected'));
      assert(JSON.stringify(reply).includes('BETA'));
    }
    const linkedRepositories = [{ root: 'a', path: null, worktree: f.linked }];
    const linkedInputs: Static<typeof GitInput>[] = [{ op: 'status', repositories: linkedRepositories },
      { op: 'log', repositories: linkedRepositories }, { op: 'show', repositories: linkedRepositories, ref: 'HEAD', detail: 'full' },
      { op: 'blame', repositories: linkedRepositories, path: 'file.txt' }];
    for (const input of linkedInputs) {
      const reply = result.Parse(toolJSON(await call(input)));
      assert('worktree' in reply && reply.worktree);
      assert.equal(await realpath(reply.worktree.worktree_root), f.linked);
      assert(reply.worktree.main_worktree_root); assert.equal(await realpath(reply.worktree.main_worktree_root), f.a);
      assert.equal(reply.worktree.worktree_branch, 'topic'); assert.equal(reply.worktree.main_branch, 'main');
      assert.equal(reply.worktree.worktree_head, f.run(f.linked, ['rev-parse', '--short=7', 'HEAD']).trim());
      assert('warning' in reply && reply.warning?.includes('[Worktree]'));
      if (input.op !== 'status') assert(JSON.stringify(reply).includes('LINKED'));
    }
    const protectedReply = await call({ op: 'blame', repositories: linkedRepositories, path: 'protected.txt' });
    assert.equal(protectedReply.isError, true); assert.match(JSON.stringify(protectedReply), /pathDenied/);
    const foreign = await call({ op: 'status', repositories: [{ root: 'a', worktree: f.b }] });
    assert.equal(foreign.isError, true); assert.match(JSON.stringify(foreign), /gitRepositoryDenied/);
    assert.equal((await client.callTool({ name: 'git', arguments: { workspaceId: workspace.id,
      input: { op: 'status', repositories, root: 'a' } } })).isError, true);
    assert.match(JSON.stringify(await call({ op: 'status', repositories }, 1)), /outputBudgetTooSmall/);
    const index = await readFile(join(f.b, '.git/index'));
    await writeFile(join(f.b, '.git/index'), 'corrupt synthetic index');
    const failed = result.Parse(toolJSON(await call({ op: 'status', repositories })));
    assert(failed.op === 'status' && 'repos' in failed);
    assert('error' in failed.repos[0]!); assert('status' in failed.repos[1]!);
    await writeFile(join(f.b, '.git/index'), index);
    await rename(join(f.linked, '.git'), join(f.base, 'retired-linked-git'));
    assert.equal((await call({ op: 'status', repositories: linkedRepositories })).isError, true);
    assert(!JSON.stringify(proof).includes('synthetic private evidence'));
    await writeFile(join(f.base, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n');
    process.stdout.write(`Git routing MCP receipt: ${f.base}/receipt.json\n`);
  } finally { await client.close(); }
});

test('a declared subroot admits its owning checkout advertised worktree for read evidence', async () => {
  const f = await fixture(), sub = join(f.a, 'sub'); await mkdir(sub);
  const runtime = new MipmuxRuntime(f.options), client = runtime.createClient(null);
  try {
    const workspace = await client.declare({ ...f.spec, roots: [{ name: 'sub', absolutePath: sub }] }, signal());
    const reply = await client.explore(workspace.id, { name: 'git', input: { op: 'status',
      repositories: [{ root: 'sub', path: null, worktree: f.linked }], maxOutputBytes: 100000 } }, signal());
    const value = result.Parse(reply); assert(value.op === 'status' && 'worktree' in value && value.worktree);
    assert.equal(await realpath(value.worktree.worktree_root), f.linked);
    await writeFile(join(f.base, 'subroot-receipt.json'), JSON.stringify(value, null, 2) + '\n');
    process.stdout.write(`Git routing subroot receipt: ${f.base}/subroot-receipt.json\n`);
  } finally { await runtime.close(); }
});

test('real SDK Git status uses frozen multi-repository ownership and requires explicit history targets', async () => {
  const f = await fixture();
  const provider = await scriptedProvider((_summary, index) => index === 1
    ? { kind: 'tool', name: 'git', input: { op: 'status', maxOutputBytes: 100000 }, stop: 'tool_use', tokens: 10 }
    : index === 2 ? { kind: 'tool', name: 'git', input: { op: 'log', maxOutputBytes: 100000 }, stop: 'tool_use', tokens: 10 }
    : index === 3 ? { kind: 'tool', name: 'git', input: { op: 'log', repositories: [{ root: 'a', path: null, worktree: f.linked }],
      maxOutputBytes: 100000 }, stop: 'tool_use', tokens: 10 }
    : { kind: 'text', text: 'complete', stop: 'end_turn', tokens: 10 });
  const runtime = new MipmuxRuntime(f.options), client = runtime.createClient(new PiRunner(provider.config, runtime.supervisor, (operation, signal) => runtime.renderPresentation(operation, signal)));
  try {
    const workspace = await client.declare(f.spec, signal());
    const job = client.build(workspace.id, 'git-read-routing', { task: 'Inspect selected repositories', constraints: '',
      initialSelection: { codemapMode: 'manual', sources: [] }, duplicateUserInstructionsAtTop: false,
      copyPreset: 'standard', purpose: 'investigation', enhancementMode: 'preserve',
      requiredSources: [{ kind: 'full', source: { root: 'a', path: 'file.txt' } },
        { kind: 'full', source: { root: 'b', path: 'file.txt' } }], documents: [], patches: [], discoveryHints: [],
      budgetUnits: 100000, outputName: 'packet' });
    const terminal = await client.wait(job.jobId, 10000, signal(), () => {});
    assert.equal(terminal.state, 'ready', JSON.stringify(terminal));
    const messages = JSON.stringify(provider.requests.at(-1)?.messages);
    assert(messages.includes('"repos"') || messages.includes('\\"repos\\"'), messages);
    assert(messages.includes('gitExplicitRepositoryRequired'), messages);
    assert(messages.includes('LINKED') && messages.includes('[Worktree]'), messages);
    assert(!messages.includes('Invalid arguments'), messages);
    await writeFile(join(f.base, 'sdk-receipt.json'), JSON.stringify({ terminal, requests: provider.requests }, null, 2) + '\n');
    process.stdout.write(`Git routing SDK receipt: ${f.base}/sdk-receipt.json\n`);
  } finally { await runtime.close(); await provider.close(); }
});

test('cancelling multi-repository status settles every supervised process and permits a later read', async t => {
  const f = await fixture(), runtime = new MipmuxRuntime(f.options), client = runtime.createClient(null);
  const spawn = runtime.supervisor.spawn.bind(runtime.supervisor), held: OwnedProcess[] = [];
  let armed = true, entered!: () => void;
  const holding = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(runtime.supervisor, 'spawn', (spec: ProcessSpec) => {
    if (armed && spec.executable === git && spec.args.includes('status')) {
      const child = spawn({ ...spec, executable: process.execPath, args: [resolve('test/fixtures/held-git-read.mjs')] });
      held.push(child);
      child.child.stderr.on('data', data => { if (data.toString().includes('MIPMUX_GIT_READ_HELD')) entered(); });
      return child;
    }
    return spawn(spec);
  });
  try {
    const workspace = await client.declare(f.spec, signal()), controller = new AbortController();
    const input = { op: 'status' as const, repositories: [{ root: 'a', path: null, worktree: null }, { root: 'b', path: null, worktree: null }], maxOutputBytes: 100000 };
    const pending = client.explore(workspace.id, { name: 'git', input }, controller.signal);
    await holding; controller.abort(); await assert.rejects(pending, /cancelled|aborted/i);
    const joined = await Promise.all(held.map(child => child.closed)); assert(joined.length > 0);
    armed = false;
    const usable = result.Parse(await client.explore(workspace.id, { name: 'git', input }, signal()));
    assert(usable.op === 'status' && 'repos' in usable && usable.repos.length === 2);
    await writeFile(join(f.base, 'cancel-receipt.json'), JSON.stringify({ joined, usable }, null, 2) + '\n');
    process.stdout.write(`Git routing cancellation receipt: ${f.base}/cancel-receipt.json\n`);
  } finally { await runtime.close(); }
});

test('implicit Git status resolves a declared metadata directory and skips only absent repositories', async () => {
  const f = await fixture(), metadata = join(f.base, 'metadata'), worktree = join(f.base, 'metadata-worktree'), plain = join(f.base, 'plain');
  await mkdir(worktree); await mkdir(plain);
  f.run(worktree, ['init', '--separate-git-dir', metadata]); f.run(worktree, ['config', 'core.worktree', worktree]);
  await writeFile(join(worktree, 'metadata.txt'), 'METADATA_WORKTREE\n');
  const runtime = new MipmuxRuntime(f.options), proof: unknown[] = [];
  try {
    for (const roots of [[{ name: 'meta', absolutePath: metadata }],
      [{ name: 'plain', absolutePath: plain }, { name: 'meta', absolutePath: metadata }, { name: 'b', absolutePath: f.b }]]) {
      const workspace = await runtime.declare({ ...f.spec, roots }, signal()), operation = await workspace.openOperation(signal());
      try {
        const explicit = result.Parse(await operation.readGit({ op: 'status', repositories: [{ root: 'meta', path: null, worktree: null }], maxOutputBytes: 100000 }));
        const implicit = result.Parse(await operation.readGit({ op: 'status', repositories: null, maxOutputBytes: 100000 }));
        assert(explicit.op === 'status' && 'status' in explicit && implicit.op === 'status' && 'status' in implicit);
        assert.deepEqual(implicit.repository, explicit.repository); assert.deepEqual(implicit.status, explicit.status);
        assert.equal(implicit.repository.worktree.canonicalPath, worktree); assert(implicit.status.untracked.includes('metadata.txt'));
        proof.push({ explicit, implicit });
      } finally { await operation.close(); }
    }
    const workspace = await runtime.declare({ ...f.spec, roots: [{ name: 'plain', absolutePath: plain }] }, signal());
    const operation = await workspace.openOperation(signal());
    try { await assert.rejects(operation.readGit({ op: 'status', repositories: null, maxOutputBytes: 100000 }), /gitTargetRequired/); }
    finally { await operation.close(); }
    await writeFile(join(f.base, 'metadata-receipt.json'), JSON.stringify(proof, null, 2) + '\n');
    process.stdout.write(`Git routing metadata receipt: ${f.base}/metadata-receipt.json\n`);
  } finally { await runtime.close(); }
});

test('implicit Git discovery does not skip security or protocol failures to read another repository', async t => {
  const f = await fixture(), plain = join(f.base, 'plain'); await mkdir(plain);
  const cases = [{ code: 'gitQueryFailed', script: 'process.stderr.write("fatal: detected dubious ownership in repository\\n");process.exit(128)' },
    { code: 'gitProtocolError', script: 'process.stdout.write("unterminated")' }];
  const proof: string[] = [];
  for (const scenario of cases) {
    const runtime = new MipmuxRuntime(f.options), spawn = runtime.supervisor.spawn.bind(runtime.supervisor);
    t.mock.method(runtime.supervisor, 'spawn', (spec: ProcessSpec) => spec.executable === git && spec.cwd === plain && spec.args.includes('--show-toplevel')
      ? spawn({ ...spec, executable: process.execPath, args: ['-e', scenario.script] }) : spawn(spec));
    try {
      const workspace = await runtime.declare({ ...f.spec, roots: [{ name: 'plain', absolutePath: plain }, { name: 'b', absolutePath: f.b }] }, signal());
      const operation = await workspace.openOperation(signal());
      try { await assert.rejects(operation.readGit({ op: 'status', repositories: null, maxOutputBytes: 100000 }), new RegExp(scenario.code)); }
      finally { await operation.close(); }
      proof.push(scenario.code);
    } finally { await runtime.close(); }
  }
  await writeFile(join(f.base, 'discovery-failure-receipt.json'), JSON.stringify(proof, null, 2) + '\n');
  process.stdout.write(`Git routing discovery failure receipt: ${f.base}/discovery-failure-receipt.json\n`);
});
