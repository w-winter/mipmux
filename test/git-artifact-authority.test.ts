import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { ContextBuildRequest } from '../src/contracts/context.js';
import { gitValidator } from '../src/contracts/git.js';
import { MipmuxRuntime } from '../src/runtime/mipmux-runtime.js';
import type { RuntimeOptions } from '../src/runtime/mipmux-runtime.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';

const signal = () => new AbortController().signal;
const git = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');

async function fixture(makeRuntime: (options: RuntimeOptions) => MipmuxRuntime = options => new MipmuxRuntime(options)) {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-artifact-authority-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await mkdir('test-output', { recursive: true });
  const run = (args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'file.txt'), 'base\n'); run(['add', '.']); run(['commit', '-qm', 'base']);
  await writeFile(join(root, 'file.txt'), 'changed\n');
  const request: ContextBuildRequest = { task: 'Collect evidence', constraints: '', enhancementMode: 'preserve', purpose: 'review',
    initialSelection: { codemapMode: 'manual', sources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } }] },
    requiredSources: [], documents: [], patches: [], copyPreset: 'standard',
    duplicateUserInstructionsAtTop: false, discoveryHints: [], budgetUnits: 200000, outputName: 'packet' };
  const runtime = makeRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: {}, credentialPaths: [], terminationGraceMs: 100, contextBudgetUnits: 200000, git: { executable: git } });
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal());
  const draft = await workspace.createDraft(request, signal());
  const diff = gitValidator.Parse(gitValidator.Default({ op: 'diff', maxOutputBytes: 100000 })); assert(diff.op === 'diff');
  const options = { mode: 'standard' as const, scope: 'all' as const, snapshotID: 'first',
    inlineMap: true, inlineMode: 'brief', inlineMaxLines: 120 };
  return { base, root, out, runtime, workspace, draft, request, diff, options, run };
}

test('published aliases require exact draft grants, catalog membership and current manifest/checkout authority', async () => {
  const f = await fixture();
  try {
    const published = await f.draft.publishGitSnapshot(f.diff, f.options, signal()); assert(published.kind === 'single');
    const aliases = published.projection.advertisedSelectionAliases, primary = published.projection.primarySelectionAliases;
    assert.equal(primary.length, 2); assert.equal(aliases.length, 3);
    const map = primary[0]!;
    const read = await f.draft.readGitArtifact(map, signal());
    assert.equal(read.text, await readFile(join(f.out, map), 'utf8'));
    for (const alias of aliases) assert((await f.draft.readGitArtifact(alias, signal())).text.length > 0);
    await assert.rejects(f.draft.readGitArtifact('_git_data/' + published.snapshotDir + '/manifest.json', signal()), /gitArtifactNotAdvertised/);
    await assert.rejects(f.draft.readGitArtifact(map.replace('MAP.txt', '../MAP.txt'), signal()), /gitArtifactNotAdvertised/);
    const other = await f.workspace.createDraft(f.request, signal());
    await assert.rejects(other.readGitArtifact(map, signal()), /gitArtifactNotAdvertised/); await other.close();
    f.run(['add', '.']); f.run(['commit', '-qm', 'later HEAD']);
    await writeFile(join(f.root, 'file.txt'), 'later working tree\n');
    assert.equal((await f.draft.readGitArtifact(map, signal())).text, read.text);
    const manifestPath = join(f.out, '_git_data', published.snapshotDir, 'manifest.json');
    const original = await readFile(manifestPath, 'utf8');
    for (const change of [{ repoKey: 'wrong' }, { snapshotID: 'wrong' }, { repoRoot: f.base }, { isWorktree: true },
      { commonGitDir: f.base }, { worktreeRoot: f.root }, { worktreeName: 'forged' }, { mainWorktreeRoot: f.root },
      { tabID: '11111111-1111-4111-8111-111111111111' }, { files: [] }]) {
      await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(original), ...change }));
      const alias = 'files' in change ? aliases[2]! : map;
      await assert.rejects(f.draft.readGitArtifact(alias, signal()), /gitArtifactUnauthorized/);
    }
    await writeFile(manifestPath, original);
    await unlink(join(f.out, map)); await symlink(join(f.root, 'file.txt'), join(f.out, map));
    await assert.rejects(f.draft.readGitArtifact(map, signal()), /symlink|nonRegularFile/);
    await unlink(join(f.out, map)); await writeFile(join(f.out, map), read.text);
    const second = await f.draft.publishGitSnapshot(f.diff, { ...f.options, snapshotID: 'second' }, signal());
    assert(second.kind === 'single');
    await assert.rejects(f.draft.readGitArtifact(map, signal()), /gitArtifactNotAdvertised/);
    assert((await f.draft.readGitArtifact(second.projection.primarySelectionAliases[0]!, signal())).text.includes('second'));
    await writeFile('test-output/git-artifact-authority-proof.json', JSON.stringify({ first: aliases,
      second: second.projection.advertisedSelectionAliases, historicalBody: read.text,
      revokedOldGrant: true, deniedOtherDraft: true, deniedForgedManifest: true, deniedSymlink: true }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});

test('manifest ingress failure advertises no selectable authority and cancellation keeps completed snapshots', async () => {
  let interrupt: 'missing' | 'cancel' | null = 'missing';
  const controller = new AbortController();
  const f = await fixture(options => {
    class Runtime extends MipmuxRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
            if (operation.kind === 'readGitSnapshotFile' && operation.path === 'manifest.json') {
              if (interrupt === 'missing') throw new NativeFailure('notFound', 2);
              if (interrupt === 'cancel') controller.abort();
            }
            return super.request(operation, requestSignal);
          }
        }
        return new Bridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
      }
    }
    return new Runtime(options);
  });
  try {
    const missing = await f.draft.publishGitSnapshot(f.diff, f.options, signal()); assert(missing.kind === 'single');
    assert(missing.projection.reply.warning?.includes('manifest.json'));
    await assert.rejects(f.draft.readGitArtifact(missing.projection.primarySelectionAliases[0]!, signal()), /gitArtifactNotAdvertised/);
    interrupt = null;
    const ready = await f.draft.publishGitSnapshot(f.diff, { ...f.options, snapshotID: 'ready' }, signal()); assert(ready.kind === 'single');
    interrupt = 'cancel';
    await assert.rejects(f.draft.publishGitSnapshot(f.diff, { ...f.options, snapshotID: 'cancelled' }, controller.signal), /cancelled|aborted/i);
    assert((await readFile(join(f.out, '_git_data', ready.snapshotDir.replace('/ready', '/cancelled'), 'MAP.txt'), 'utf8')).includes('cancelled'));
    interrupt = null;
    assert((await f.draft.readGitArtifact(ready.projection.primarySelectionAliases[0]!, signal())).text.includes('ready'));
  } finally { await f.runtime.close(); }
});

test('Git artifact output access retains configured credential denies', async () => {
  const f = await fixture(options => new MipmuxRuntime({ ...options,
    credentialPaths: [join(options.cachePath, '../out/_git_data')] }));
  try {
    const published = await f.draft.publishGitSnapshot(f.diff, f.options, signal()); assert(published.kind === 'single');
    assert(published.projection.reply.warning?.includes('pathDenied'));
    for (const alias of published.projection.advertisedSelectionAliases) {
      await assert.rejects(f.draft.readGitArtifact(alias, signal()), /gitArtifactNotAdvertised/);
    }
  } finally { await f.runtime.close(); }
});

test('advertisement replacement invalidates a pending read and checkout changes during ingress prevent installation', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  let hold = false, moved = false, moveCheckout: () => Promise<void> = async () => {};
  const f = await fixture(options => {
    class Runtime extends MipmuxRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
            if (hold && operation.kind === 'authorizeGitArtifact') {
              hold = false; enter(); await resume;
            }
            const result = await super.request(operation, requestSignal);
            if (moved && operation.kind === 'readGitSnapshotFile' && operation.path === 'manifest.json') {
              moved = false; await moveCheckout();
            }
            return result;
          }
        }
        return new Bridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
      }
    }
    return new Runtime(options);
  });
  try {
    const first = await f.draft.publishGitSnapshot(f.diff, f.options, signal()); assert(first.kind === 'single');
    hold = true;
    const pending = assert.rejects(f.draft.readGitArtifact(first.projection.primarySelectionAliases[0]!, signal()), /gitArtifactAdvertisementChanged/);
    await entered;
    await f.draft.publishGitSnapshot(f.diff, { ...f.options, snapshotID: 'replacement' }, signal());
    release(); await pending;
    moveCheckout = () => rename(join(f.root, '.git'), join(f.root, '.git-moved'));
    moved = true;
    await assert.rejects(f.draft.publishGitSnapshot(f.diff, { ...f.options, snapshotID: 'stale' }, signal()), /gitRepositoryChanged/);
    await rename(join(f.root, '.git-moved'), join(f.root, '.git'));
    assert((await readFile(join(f.out, '_git_data', first.snapshotDir.replace('/first', '/stale'), 'MAP.txt'), 'utf8')).includes('stale'));
  } finally { release(); await f.runtime.close(); }
});
