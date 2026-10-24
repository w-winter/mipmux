import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MipmuxRuntime, verifyBundle, type ContextBuildRequest } from '../src/index.js';
import { gitValidator } from '../src/contracts/git.js';
import { GitArtifactReply } from '../src/contracts/git-artifact.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import { toolJSON } from './fixtures/tool-json.js';

const signal = () => new AbortController().signal;
const git = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const publication = Compile(GitArtifactReply);
const identifier = Compile(Type.Object({ id: Type.String() }));
const jobIdentifier = Compile(Type.Object({ jobId: Type.String() }));
const terminalReply = Compile(Type.Object({ state: Type.String(), localSettled: Type.Boolean() }));
const disposed = Compile(Type.Object({ kind: Type.Literal('disposed'), deletedSnapshots: Type.Integer() }));

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-context-disposal-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'file.txt'), 'base\n'); run(['add', '.']); run(['commit', '-qm', 'base']);
  await writeFile(join(root, 'file.txt'), 'disposal evidence\n');
  const request: ContextBuildRequest = { task: 'Capture evidence', constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } }] },
    requiredSources: [], documents: [], patches: [], copyPreset: 'standard',
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: 'packet' };
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000, git: { executable: git } };
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out };
  return { base, root, out, request, options, spec };
}

test('explicit draft disposal removes only current owner manifests and retains packets and other contexts', async () => {
  const f = await fixture(), runtime = new MipmuxRuntime(f.options), client = runtime.createClient(null);
  const proof: unknown[] = [];
  try {
    const workspace = await client.declare(f.spec, signal());
    const a = await client.createDraft(workspace.id, f.request, signal());
    const b = await client.createDraft(workspace.id, { ...f.request, outputName: 'other' }, signal());
    const publish = async (draftId: string, snapshot_id: string) => publication.Parse(await client.explore(workspace.id,
      { name: 'git', input: gitValidator.Parse(gitValidator.Default({ op: 'diff', artifacts: true, snapshot_id, maxOutputBytes: 100000 })) },
      signal(), draftId));
    const first = await publish(a.id, 'first'), keep = await publish(b.id, 'keep'), latest = await publish(a.id, 'latest');
    const ready = await client.finalize(a.id, signal()); assert.equal(ready.kind, 'ready');
    assert((await readFile(join(f.out, latest.primary_artifacts.map), 'utf8')).includes('latest'));
    const stranger = runtime.createClient(null);
    assert.throws(() => stranger.disposeDraft(a.id, signal()), /unknownManualDraft/);
    const result = await client.disposeDraft(a.id, signal()); assert.equal(result.deletedSnapshots, 2);
    for (const reply of [first, latest]) await assert.rejects(readFile(join(f.out, reply.primary_artifacts.map)), { code: 'ENOENT' });
    assert((await readFile(join(f.out, keep.primary_artifacts.map), 'utf8')).includes('keep'));
    assert.equal(await readlink(join(f.out, '_git_data/repos', keep.snapshot_dir!.split('/')[1]!, 'CURRENT')), 'keep');
    await verifyBundle(join(f.out, 'packet'));
    assert.throws(() => client.inspect(a.id, { view: 'metadata', maxOutputBytes: 100000, continuation: null }, signal()), /unknownDraft/);
    proof.push({ result, packetRetained: true, otherContextRetained: true, current: 'keep', crossClientDenied: true });
    const c = await client.createDraft(workspace.id, { ...f.request, outputName: 'c' }, signal());
    const d = await client.createDraft(workspace.id, { ...f.request, outputName: 'd' }, signal());
    await publish(c.id, 'shared'); const replaced = await publish(d.id, 'shared');
    assert.equal((await client.disposeDraft(c.id, signal())).deletedSnapshots, 0);
    assert((await readFile(join(f.out, replaced.primary_artifacts.map), 'utf8')).includes('shared'));
    assert.equal((await client.disposeDraft(d.id, signal())).deletedSnapshots, 1);
    proof.push({ reusedSnapshotOwnedByLatestWriter: true });
    await client.close();
    assert((await readFile(join(f.out, keep.primary_artifacts.map), 'utf8')).includes('keep'));
  } finally { await runtime.close(); }
  await writeFile('test-output/context-draft-disposal-proof.json', JSON.stringify(proof, null, 2) + '\n');
});

test('disposal cancellation and replaced output roots retain snapshots and permit an explicit retry', async () => {
  const f = await fixture(), runtime = new MipmuxRuntime(f.options), client = runtime.createClient(null);
  try {
    const workspace = await client.declare(f.spec, signal()), draft = await client.createDraft(workspace.id, f.request, signal());
    const reply = publication.Parse(await client.explore(workspace.id, { name: 'git', input: gitValidator.Parse(gitValidator.Default({
      op: 'diff', artifacts: true, snapshot_id: 'saved', maxOutputBytes: 100000 })) }, signal(), draft.id));
    const cancelled = new AbortController(); cancelled.abort();
    assert.throws(() => client.disposeDraft(draft.id, cancelled.signal), /aborted/i);
    assert((await readFile(join(f.out, reply.primary_artifacts.map), 'utf8')).includes('saved'));
    await rename(f.out, f.out + '-original'); await mkdir(f.out);
    await assert.rejects(client.disposeDraft(draft.id, signal()), /rootChanged/);
    assert((await readFile(join(f.out + '-original', reply.primary_artifacts.map), 'utf8')).includes('saved'));
    await rename(f.out, f.out + '-replacement'); await rename(f.out + '-original', f.out);
    assert.equal((await client.disposeDraft(draft.id, signal())).deletedSnapshots, 1);
    await assert.rejects(readFile(join(f.out, reply.primary_artifacts.map)), { code: 'ENOENT' });
    await writeFile('test-output/context-disposal-failure-proof.json', JSON.stringify({ preabortedRetained: true,
      replacedRootDenied: true, explicitRetryDeleted: true }, null, 2) + '\n');
  } finally { await runtime.close(); }
});

test('MCP job disposal joins real Pi discovery before owner cleanup and retains completed packet bytes', async () => {
  const proof: unknown[] = [];
  for (const finish of [false, true]) {
    const f = await fixture(); let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const provider = await scriptedProvider((_summary, index) => index === 1
      ? { kind: 'tool', name: 'git', input: { op: 'diff', artifacts: true, snapshot_id: 'job', maxOutputBytes: 100000 }, stop: 'tool_use', tokens: 10 }
      : finish ? { kind: 'text', text: 'complete', stop: 'end_turn', tokens: 10 } : { kind: 'hold', entered });
    const config = join(f.base, 'config.json');
    await writeFile(config, JSON.stringify({ ...f.options, discovery: provider.config, defaultMaxOutputBytes: 100000 }));
    const client = new Client({ name: 'context-job-disposal', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config],
      cwd: '/', stderr: 'pipe' });
    try {
      await client.connect(transport);
      const workspaceId = identifier.Parse(toolJSON(await client.callTool({ name: 'workspace_declare', arguments: { spec: f.spec } }))).id;
      const args = { workspaceId, requestId: 'job', request: f.request };
      const job = jobIdentifier.Parse(toolJSON(await client.callTool({ name: 'context_builder', arguments: args })));
      if (finish) {
        const waited = await client.callTool({ name: 'context_builder_wait', arguments: { jobId: job.jobId, durationMs: 10000 } });
        assert.equal(terminalReply.Parse(toolJSON(waited)).state, 'ready');
      }
      else await waiting;
      const result = await client.callTool({ name: 'context_builder_dispose', arguments: { jobId: job.jobId } });
      assert.equal(result.isError, false); assert.equal(disposed.Parse(toolJSON(result)).deletedSnapshots, 1);
      const receipt = await client.callTool({ name: 'context_builder_result', arguments: { jobId: job.jobId } });
      const terminal = terminalReply.Parse(toolJSON(receipt)); assert.equal(terminal.localSettled, true);
      assert.equal(terminal.state, finish ? 'ready' : 'cancelled');
      const repeated = await client.callTool({ name: 'context_builder_dispose', arguments: { jobId: job.jobId } });
      assert.equal(disposed.Parse(toolJSON(repeated)).deletedSnapshots, 0);
      assert.equal(jobIdentifier.Parse(toolJSON(await client.callTool({ name: 'context_builder', arguments: args }))).jobId, job.jobId);
      if (finish) await verifyBundle(join(f.out, 'packet'));
      else await assert.rejects(readFile(join(f.out, 'packet/manifest.json')), { code: 'ENOENT' });
      proof.push({ finish, result, receipt, repeated });
    } finally { await client.close(); await provider.close(); }
  }
  await writeFile('test-output/context-job-disposal-proof.json', JSON.stringify(proof, null, 2) + '\n');
});

test('MCP draft_dispose performs owner cleanup after finalization and workspace closure', async () => {
  const f = await fixture(), config = join(f.base, 'config.json');
  await writeFile(config, JSON.stringify({ ...f.options, discovery: null, defaultMaxOutputBytes: 100000 }));
  const client = new Client({ name: 'context-disposal', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config],
    cwd: '/', stderr: 'pipe' });
  try {
    await client.connect(transport);
    const workspaceId = identifier.Parse(toolJSON(await client.callTool({ name: 'workspace_declare', arguments: { spec: f.spec } }))).id;
    const draftId = identifier.Parse(toolJSON(await client.callTool({ name: 'draft_create', arguments: { workspaceId, request: f.request } }))).id;
    const published = await client.callTool({ name: 'git', arguments: { workspaceId, draftId,
      input: { op: 'diff', artifacts: true, snapshot_id: 'mcp' } } }); assert.equal(published.isError, false);
    const reply = publication.Parse(toolJSON(published));
    assert.equal((await client.callTool({ name: 'draft_finalize', arguments: { draftId } })).isError, false);
    await client.callTool({ name: 'workspace_close', arguments: { workspaceId } });
    const result = await client.callTool({ name: 'draft_dispose', arguments: { draftId } }); assert.equal(result.isError, false);
    assert.equal(disposed.Parse(toolJSON(result)).deletedSnapshots, 1);
    await assert.rejects(readFile(join(f.out, reply.primary_artifacts.map)), { code: 'ENOENT' });
    await verifyBundle(join(f.out, 'packet'));
    await writeFile('test-output/context-disposal-mcp-proof.json', JSON.stringify({ published, result, packetRetained: true }, null, 2) + '\n');
  } finally { await client.close(); }
});
