import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Compile } from 'typebox/compile';
import { MipmuxRuntime, verifyBundle, type ContextBuildRequest } from '../src/index.js';
import { gitValidator, type GitRequest } from '../src/contracts/git.js';
import { GitArtifactReply } from '../src/contracts/git-artifact.js';
import { selectionValidator } from '../src/contracts/selection.js';
import { scopedCall } from '../src/discovery/scoped-tools.js';
import { piToolResult } from '../src/runtime/tool-result.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import type { RuntimeOptions } from '../src/runtime/mipmux-runtime.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import Type from 'typebox';
import { GitArtifactReposReply } from '../src/contracts/git-artifact.js';
import { Continuation, readValidator, type ReadRequest } from '../src/contracts/exploration.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { toolJSON } from './fixtures/tool-json.js';

const signal = () => new AbortController().signal;
const git = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const replyValidator = Compile(GitArtifactReply);
const readReplyValidator = Compile(Type.Object({ kind: Type.Literal('read'), content: Type.String(),
  firstLine: Type.Integer(), lastLine: Type.Integer(), returnedLineCount: Type.Integer(),
  continuation: Type.Union([Continuation, Type.Null()]) }));

async function fixture(makeRuntime: (options: RuntimeOptions) => MipmuxRuntime = options => new MipmuxRuntime(options)) {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-scout-artifacts-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'file.txt'), 'base\n'); await writeFile(join(root, 'slice.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(root, 'code.swift'), 'struct Example { let value: Int }\n');
  run(['add', '.']); run(['commit', '-qm', 'base']); await writeFile(join(root, 'file.txt'), 'scout artifact change\n');
  const request: ContextBuildRequest = { task: 'Collect Git evidence', constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } },
      { kind: 'slices', source: { root: 'r', path: 'slice.txt' }, ranges: [{ start: 2, end: 2, description: null }] },
      { kind: 'codemap', source: { root: 'r', path: 'code.swift' } }] },
    requiredSources: [], documents: [], patches: [], copyPreset: 'codeReview',
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: 'packet' };
  const options = { copyContext: copyContext(), cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000, git: { executable: git } };
  const runtime = makeRuntime(options);
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal());
  const draft = await workspace.createDraft(request, signal());
  const publication = (extra: Partial<Extract<GitRequest, { op: 'diff'; artifacts: true }>>) => gitValidator.Parse(gitValidator.Default({
    op: 'diff', artifacts: true, snapshot_id: 'scout', maxOutputBytes: 100000, ...extra }));
  return { root, out, options, request, runtime, workspace, draft, publication };
}

test('scout publication commits mutable primary artifacts before reply encoding and installs grants afterward', async () => {
  const f = await fixture(), operation = await f.workspace.openOperation(signal());
  try {
    let pendingRead: Promise<void> | null = null;
    const reply = replyValidator.Parse(await scopedCall({ name: 'git', input: f.publication({ mode: 'STANDARD', scope: 'ALL',
      inline: { map: true, mode: 'BRIEF', max_lines: 0 } }) }, f.draft, operation, signal(), value => {
      const encoded = replyValidator.Parse(value);
      pendingRead = assert.rejects(f.draft.readGitArtifact(encoded.primary_artifacts.map, signal()), /gitArtifactNotAdvertised/);
      return piToolResult(value);
    }));
    await pendingRead;
    assert.equal(reply.inline?.returned_lines, 1);
    assert.deepEqual(reply.primary_artifacts.auto_selected, [reply.primary_artifacts.map, reply.primary_artifacts.all_patch]);
    const selected = await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get',
      maxOutputBytes: 100000 })), signal());
    assert.equal(selected.revision, 1); assert.equal(selected.summary.full_count, 3);
    assert.equal(selected.summary.slice_count, 1); assert.equal(selected.summary.codemap_count, 1);
    assert.equal(selected.codemap_auto_enabled, false);
    assert((await f.draft.readGitArtifact(reply.primary_artifacts.map, signal())).text.includes('scout'));
    const repeated = replyValidator.Parse(await scopedCall({ name: 'git', input: f.publication({}) }, f.draft, operation, signal(), piToolResult));
    assert(!repeated.primary_artifacts.auto_selected?.length); assert.equal(f.draft.revision, 1);
    const perFile = reply.primary_artifacts.per_file_patches?.[0]?.selection_path; assert(perFile);
    const removed = await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'remove',
      paths: [reply.primary_artifacts.all_patch], maxOutputBytes: 100000 })), signal());
    assert.equal(removed.revision, 2);
    await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'add', paths: [perFile],
      maxOutputBytes: 100000 })), signal());
    const ready = await f.draft.finalize(signal()); assert(ready.kind === 'ready'); await verifyBundle(ready.directory);
    await writeFile('test-output/scout-git-artifacts-proof.json', JSON.stringify({ reply, selected, repeated, ready,
      grantsInstalledAfterEncoding: true, primariesMutable: true }, null, 2) + '\n');
  } finally { await operation.close(); await f.runtime.close(); }
});

test('failed or cancelled artifact replies retain publication and committed selection but install no new grant', async () => {
  for (const effect of ['cap', 'cancelEncoding', 'cancelGrant', 'cancelPerFileGrant'] as const) {
    const controller = new AbortController(); let encoded = false;
    const f = await fixture(options => {
      class Runtime extends MipmuxRuntime {
        override makeBridge() {
          class Bridge extends BridgeClient {
            publicationOwner = false;
            override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
              if (operation.kind === 'normalizeGitPublicationOptions') this.publicationOwner = true;
              const result = await super.request(operation, requestSignal);
              if (effect === 'cancelGrant' && encoded && !controller.signal.aborted && operation.kind === 'revalidateGitTargets') {
                controller.abort(); throw new NativeFailure('rootChanged', null);
              }
              if (effect === 'cancelPerFileGrant' && encoded && this.publicationOwner && operation.kind === 'authorizeGitArtifact' &&
                operation.path.startsWith('diff/per-file/')) {
                controller.abort(); throw new NativeFailure('rootChanged', null);
              }
              return result;
            }
          }
          return new Bridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
        }
      }
      return new Runtime(options);
    }), operation = await f.workspace.openOperation(signal());
    try {
      const input = f.publication({ maxOutputBytes: effect === 'cap' ? 1 : 100000 });
      await assert.rejects(scopedCall({ name: 'git', input }, f.draft, operation, controller.signal, value => {
        encoded = true;
        if (effect === 'cancelEncoding') controller.abort();
        return piToolResult(value);
      }), effect === 'cap' ? /outputBudgetTooSmall/ : /cancelled|aborted/i);
      const [repo] = await readdir(join(f.out, '_git_data/repos')); assert(repo);
      const alias = '_git_data/repos/' + repo + '/scout/MAP.txt';
      assert((await readFile(join(f.out, alias), 'utf8')).includes('scout'));
      assert.equal(f.draft.revision, 1);
      await assert.rejects(f.draft.readGitArtifact(alias, signal()), /gitArtifactNotAdvertised/);
      const selected = await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', maxOutputBytes: 100000 })), signal());
      assert(selected.files.some(file => file.path === alias));
    } finally { await operation.close(); await f.runtime.close(); }
  }
});

test('real Pi dispatch publishes and auto-selects Git artifacts into its completed packet', async () => {
  const f = await fixture();
  const provider = await scriptedProvider((_summary, index) => {
    if (index === 1) return { kind: 'tool', name: 'git', input: { op: 'diff', artifacts: true,
      snapshot_id: 'pi', maxOutputBytes: 100000 }, stop: 'tool_use', tokens: 10 };
    if (index === 2) {
      const alias = JSON.stringify(provider.requests.at(-1)?.messages).match(/_git_data\/repos\/[^"\\]+\/MAP\.txt/)?.[0];
      assert(alias);
      return { kind: 'tool', name: 'read_file', input: { path: alias, start_line: 1, limit: 1,
        maxOutputBytes: 100000 }, stop: 'tool_use', tokens: 10 };
    }
    return { kind: 'text', text: 'complete', stop: 'end_turn', tokens: 10 };
  });
  const runtime = new MipmuxRuntime({ ...f.options, copyContext: copyContext(), cachePath: f.options.cachePath + '-pi' });
  const client = runtime.createClient(new PiRunner(provider.config, runtime.supervisor, (operation, signal) => runtime.renderPresentation(operation, signal)));
  try {
    const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.out }, signal());
    const job = client.build(workspace.id, 'scout-artifacts', { ...f.request, outputName: 'pi-packet' });
    const terminal = await client.wait(job.jobId, 10000, signal(), () => {});
    assert.equal(terminal.state, 'ready', JSON.stringify(terminal)); assert.equal(terminal.localSettled, true);
    const returned = JSON.stringify(provider.requests.at(-1)?.messages);
    assert(!returned.includes('Invalid arguments')); assert(returned.includes('auto_selected'));
    assert(returned.includes('returnedLineCount')); assert(returned.includes('# MAP.txt v1'));
    const packet = await verifyBundle(join(f.out, 'pi-packet'));
    assert.equal(packet.manifest.materials.filter(material => material.kind === 'gitMap').length, 1);
    assert.equal(packet.manifest.materials.filter(material => material.kind === 'gitPatch').length, 1);
    await writeFile('test-output/scout-git-artifacts-pi-proof.json', JSON.stringify({ terminal,
      materials: packet.manifest.materials, messages: provider.requests.at(-1)?.messages }, null, 2) + '\n');
  } finally { await runtime.close(); await provider.close(); await f.runtime.close(); }
});

test('primary commit failure warns and later grant authorization failure retains the encoded publication reply', async () => {
  let denyPrimary = true;
  const f = await fixture(options => {
    class Runtime extends MipmuxRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
            if (denyPrimary && operation.kind === 'authorizeGitArtifact') {
              denyPrimary = false; throw new NativeFailure('notFound', 2);
            }
            return super.request(operation, requestSignal);
          }
        }
        return new Bridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
      }
    }
    return new Runtime(options);
  });
  const operation = await f.workspace.openOperation(signal());
  try {
    const warned = replyValidator.Parse(await scopedCall({ name: 'git', input: f.publication({}) }, f.draft, operation, signal(), piToolResult));
    assert(warned.warning?.includes('could not be committed')); assert(!warned.primary_artifacts.auto_selected?.length);
    assert.equal(f.draft.revision, 0); assert((await f.draft.readGitArtifact(warned.primary_artifacts.map, signal())).text.length > 0);
    const reply = replyValidator.Parse(await scopedCall({ name: 'git', input: f.publication({ snapshot_id: 'late' }) }, f.draft, operation, signal(), value => {
      renameSync(join(f.root, '.git'), join(f.root, 'retired-git'));
      return piToolResult(value);
    }));
    renameSync(join(f.root, 'retired-git'), join(f.root, '.git'));
    assert.equal(reply.snapshot_id, 'late'); assert.equal(f.draft.revision, 1);
    await assert.rejects(f.draft.readGitArtifact(reply.primary_artifacts.map, signal()), /gitArtifactNotAdvertised/);
    assert((await readFile(join(f.out, reply.primary_artifacts.map), 'utf8')).includes('late'));
  } finally { await operation.close(); await f.runtime.close(); }
});

test('a per-file-only authorization change after encoding revokes the complete advertisement grant', async () => {
  const f = await fixture(), operation = await f.workspace.openOperation(signal());
  const manifest = Compile(Type.Object({ files: Type.Array(Type.Object({ gitPath: Type.String() })) }));
  let original = '', manifestPath = '';
  try {
    const previous = replyValidator.Parse(await scopedCall({ name: 'git', input: f.publication({ snapshot_id: 'previous' }) },
      f.draft, operation, signal(), piToolResult));
    const published = replyValidator.Parse(await scopedCall({ name: 'git', input: f.publication({ snapshot_id: 'late-per-file' }) },
      f.draft, operation, signal(), value => {
        const result = replyValidator.Parse(value); assert(result.primary_artifacts.per_file_patches?.length);
        manifestPath = join(f.out, '_git_data', result.snapshot_dir!, 'manifest.json');
        original = readFileSync(manifestPath, 'utf8');
        const changed = manifest.Parse(JSON.parse(original)); changed.files = [];
        writeFileSync(manifestPath, JSON.stringify(changed));
        return piToolResult(value);
      }));
    for (const alias of [previous.primary_artifacts.map, published.primary_artifacts.map, published.primary_artifacts.all_patch]) {
      assert(alias); await assert.rejects(f.draft.readGitArtifact(alias, signal()), /gitArtifactNotAdvertised/);
    }
    assert.equal(f.draft.revision, 2);
    const selected = await f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get',
      maxOutputBytes: 100000 })), signal());
    assert(selected.files.some(file => file.path === published.primary_artifacts.map));
    await writeFile('test-output/scout-git-late-grant-proof.json', JSON.stringify({ published, selected,
      perFileOnlyManifestChange: true, entireGrantRevoked: true, previousGrantRevoked: true, selectionRetained: true }, null, 2) + '\n');
  } finally {
    if (original) writeFileSync(manifestPath, original);
    await operation.close(); await f.runtime.close();
  }
});

test('MCP publication requires an owned draft and uses the same source commit and grant pipeline', async () => {
  const f = await fixture(), config = join(f.out, '../host.json');
  await writeFile(config, JSON.stringify({ ...f.options, discovery: null, defaultMaxOutputBytes: 100000 }));
  const client = new Client({ name: 'scout-artifact-mcp', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config],
    cwd: '/', stderr: 'pipe' });
  try {
    await client.connect(transport);
    const identifier = Compile(Type.Object({ id: Type.String() }));
    const declared = await client.callTool({ name: 'workspace_declare', arguments: { spec: {
      roots: [{ name: 'r', absolutePath: f.root }], exclusions: [], outputRoot: f.out } } });
    assert.equal(declared.isError, false); const workspaceId = identifier.Parse(toolJSON(declared)).id;
    const denied = await client.callTool({ name: 'git', arguments: { workspaceId, input: { op: 'diff', artifacts: true } } });
    assert.equal(denied.isError, true); assert(JSON.stringify(denied).includes('draftRequired'));
    const created = await client.callTool({ name: 'draft_create', arguments: { workspaceId, request: f.request } });
    assert.equal(created.isError, false); const draftId = identifier.Parse(toolJSON(created)).id;
    const published = await client.callTool({ name: 'git', arguments: { workspaceId, draftId,
      input: { op: 'diff', artifacts: true, snapshot_id: '../invalid', mode: 'QUICK' } } });
    assert.equal(published.isError, false, JSON.stringify(published));
    const reply = replyValidator.Parse(toolJSON(published));
    assert.notEqual(reply.snapshot_id, '../invalid'); assert(!reply.primary_artifacts.all_patch);
    assert.deepEqual(reply.primary_artifacts.auto_selected, [reply.primary_artifacts.map]);
    const selected = await client.callTool({ name: 'manage_selection', arguments: { draftId, input: { op: 'get' } } });
    assert.equal(selected.isError, false); assert(JSON.stringify(toolJSON(selected)).includes(reply.primary_artifacts.map));
    const artifactRead = await client.callTool({ name: 'read_file', arguments: { workspaceId, draftId,
      input: { path: reply.primary_artifacts.map, start_line: 1, limit: 1 } } });
    assert.equal(artifactRead.isError, false, JSON.stringify(artifactRead));
    assert.equal(readReplyValidator.Parse(toolJSON(artifactRead)).content, '# MAP.txt v1\n');
    const unownedRead = await client.callTool({ name: 'read_file', arguments: { workspaceId,
      input: { path: reply.primary_artifacts.map } } });
    assert.equal(unownedRead.isError, true); assert(JSON.stringify(unownedRead).includes('draftRequired'));
    const other = identifier.Parse(toolJSON(await client.callTool({ name: 'draft_create', arguments: { workspaceId,
      request: { ...f.request, outputName: 'other' } } })));
    const unselectedRead = await client.callTool({ name: 'read_file', arguments: { workspaceId, draftId: other.id,
      input: { path: reply.primary_artifacts.map } } });
    assert.equal(unselectedRead.isError, true); assert(JSON.stringify(unselectedRead).includes('already be selected and authorized'));
    await writeFile('test-output/scout-git-artifacts-mcp-proof.json', JSON.stringify({ denied, published, selected,
      artifactRead, unownedRead, unselectedRead }, null, 2) + '\n');
  } finally { await client.close(); await f.runtime.close(); }
});

test('scout reads selected historical artifacts, not merely advertised aliases, with source ranges and paging', async () => {
  const f = await fixture(), operation = await f.workspace.openOperation(signal());
  const read = (path: string, settings: Partial<Omit<ReadRequest, 'root' | 'path'>> = {}, requestSignal = signal()) => scopedCall({ name: 'read_file',
    input: readValidator.Parse(readValidator.Default({ root: null, path, maxOutputBytes: 100000, ...settings })) },
  f.draft, operation, requestSignal, piToolResult);
  const select = (op: 'add' | 'remove', path: string) => f.draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({
    op, paths: [path], maxOutputBytes: 100000 })), signal());
  try {
    const publication = replyValidator.Parse(await scopedCall({ name: 'git', input: f.publication({}) }, f.draft, operation, signal(), piToolResult));
    const map = publication.primary_artifacts.map, patch = publication.primary_artifacts.all_patch;
    const perFile = publication.primary_artifacts.per_file_patches?.[0]?.selection_path; assert(patch); assert(perFile);
    const revision = f.draft.revision;
    assert.equal(readReplyValidator.Parse(await read(map, { limit: 1 })).content, '# MAP.txt v1\n');
    await assert.rejects(read(perFile), /gitArtifactReadDenied/);
    await select('add', perFile); assert(readReplyValidator.Parse(await read(perFile)).content.includes('scout artifact change'));
    await scopedCall({ name: 'git', input: f.publication({ snapshot_id: 'new' }) }, f.draft, operation, signal(), piToolResult);
    await assert.rejects(f.draft.readGitArtifact(map, signal()), /gitArtifactNotAdvertised/);
    assert.equal(readReplyValidator.Parse(await read(map, { limit: 1 })).content, '# MAP.txt v1\n');
    await select('remove', perFile); await assert.rejects(read(perFile), /gitArtifactReadDenied/);
    await assert.rejects(read(map.replace('MAP.txt', 'manifest.json')), /gitArtifactReadDenied/);
    assert.throws(() => readValidator.Parse(readValidator.Default({ root: null, path: map.replace('MAP.txt', '../MAP.txt'), maxOutputBytes: 100000 })));
    const text = 'first\r\nsecond\rthird\nlast';
    await writeFile(join(f.out, patch), text);
    const slice = readReplyValidator.Parse(await read(patch, { start_line: '2', limit: '2' }));
    assert.equal(slice.content, 'second\rthird\n'); assert.equal(slice.firstLine, 2); assert.equal(slice.lastLine, 3);
    assert.equal(readReplyValidator.Parse(await read(patch, { start_line: -1 })).content, 'last');
    await assert.rejects(read(patch, { start_line: -1, limit: 1 }), /limitWithNegativeStart/);
    const large = Array.from({ length: 30 }, (_, index) => index + ':' + 'content'.repeat(10) + '\n').join('');
    await writeFile(join(f.out, patch), large);
    let page = readReplyValidator.Parse(await read(patch, { maxOutputBytes: 2000 }));
    assert(page.continuation); const first = page.continuation;
    let combined = page.content;
    while (page.continuation) {
      page = readReplyValidator.Parse(await read(patch, { maxOutputBytes: 2000, continuation: page.continuation }));
      combined += page.content;
    }
    assert.equal(combined, large);
    await writeFile(join(f.out, patch), large + 'changed\n');
    await assert.rejects(read(patch, { continuation: first }), /staleContinuation/);
    const manifestPath = join(f.out, map.replace('MAP.txt', 'manifest.json')), manifest = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(manifest), repoKey: 'forged' }));
    await assert.rejects(read(map), { code: 'gitArtifactReadDenied', details: {
      message: "Cannot read '" + map + "'. Git-data artifacts must already be selected and authorized.",
    } }); await writeFile(manifestPath, manifest);
    const mapBody = await readFile(join(f.out, map), 'utf8');
    await unlink(join(f.out, map)); await symlink(join(f.root, 'file.txt'), join(f.out, map));
    await assert.rejects(read(map), { code: 'gitArtifactReadDenied', details: {
      message: "Cannot read '" + map + "'. Git-data artifacts must already be selected and authorized.",
    } });
    await unlink(join(f.out, map)); await writeFile(join(f.out, map), mapBody);
    const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(read(map, {}, cancelled.signal), /aborted/i);
    assert.equal(f.draft.revision, revision + 3);
    await writeFile('test-output/scout-git-artifact-read-proof.json', JSON.stringify({ selectedHistoryReadable: true,
      advertisedOnlyDenied: true, manifestDenied: true, forgedManifestDenied: true, symlinkDenied: true,
      slice, pagedBody: combined, staleContinuationDenied: true, readsDidNotMutateSelection: true }, null, 2) + '\n');
  } finally { await operation.close(); await f.runtime.close(); }
});

test('cancellation during selected-artifact authorization propagates instead of becoming a read denial', async () => {
  const controller = new AbortController(); let interrupt = false;
  const f = await fixture(options => {
    class Runtime extends MipmuxRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
            if (interrupt && operation.kind === 'authorizeGitArtifact') {
              interrupt = false; controller.abort(); throw new NativeFailure('rootChanged', null);
            }
            return super.request(operation, requestSignal);
          }
        }
        return new Bridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
      }
    }
    return new Runtime(options);
  });
  const operation = await f.workspace.openOperation(signal());
  try {
    const publication = replyValidator.Parse(await scopedCall({ name: 'git', input: f.publication({}) }, f.draft, operation, signal(), piToolResult));
    const call = { name: 'read_file' as const, input: readValidator.Parse(readValidator.Default({ root: null,
      path: publication.primary_artifacts.map, maxOutputBytes: 100000 })) };
    interrupt = true;
    await assert.rejects(scopedCall(call, f.draft, operation, controller.signal, piToolResult), /aborted/i);
    assert.equal(readReplyValidator.Parse(await scopedCall(call, f.draft, operation, signal(), piToolResult)).content.startsWith('# MAP.txt v1'), true);
    assert.equal(f.draft.revision, 1);
  } finally { await operation.close(); await f.runtime.close(); }
});

test('implicit multi-repository scout publication auto-selects each ordered primary pair', async () => {
  const f = await fixture(), other = join(f.out, '../other');
  await mkdir(other); await writeFile(join(other, 'other.txt'), 'base\n');
  const run = (args: string[]) => execFileSync(git, args, { cwd: other, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: other, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  run(['add', '.']); run(['commit', '-qm', 'base']); await writeFile(join(other, 'other.txt'), 'other change\n');
  const workspace = await f.runtime.declare({ roots: [{ name: 'r', absolutePath: f.root }, { name: 's', absolutePath: other }],
    exclusions: [], outputRoot: f.out }, signal());
  const draft = await workspace.createDraft({ ...f.request, initialSelection: { codemapMode: 'manual', sources: [
    { kind: 'full', source: { root: 's', path: 'other.txt' } }, { kind: 'full', source: { root: 'r', path: 'file.txt' } }] } }, signal());
  const operation = await workspace.openOperation(signal());
  try {
    const reply = Compile(GitArtifactReposReply).Parse(await scopedCall({ name: 'git', input: f.publication({ snapshot_id: 'multi' }) },
      draft, operation, signal(), piToolResult));
    assert.equal(reply.aggregate.repo_count, 2);
    const aliases = reply.repos.flatMap(repo => 'diff' in repo ? repo.primary_artifacts?.auto_selected ?? [] : []);
    assert.equal(aliases.length, 4); assert.equal(draft.revision, 1);
    for (const alias of aliases) assert((await draft.readGitArtifact(alias, signal())).text.length > 0);
    const selected = await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get', maxOutputBytes: 100000 })), signal());
    assert.deepEqual(selected.files.slice(-4).map(file => file.path), aliases);
  } finally { await operation.close(); await f.runtime.close(); }
});
