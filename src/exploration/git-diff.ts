import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GitRequest } from '../contracts/git.js';
import type { GitSnapshotContent } from '../contracts/git-snapshot.js';
import type { NativeResult, NativeGitCheckout } from '../contracts/native.js';
import { descriptorGitMode } from '../contracts/patches.js';
import { NativeFailure } from '../native/bridge-client.js';
import { gitProcess } from '../patches/git-process.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { serializedBytes, type ResultEncoding } from './output-budget.js';
import { gitText, resolveDiffRepository } from './git-repository.js';
import { captureGitFingerprint } from './git-fingerprint.js';

type DiffRequest = Extract<GitRequest, { op: 'diff' }>;
type Repository = Awaited<ReturnType<typeof resolveDiffRepository>>;
type DiffCommands = Extract<NativeResult, { kind: 'gitDiffArguments' }>;
const pathspecByteLimit = 128 * 1024;
const pathspecChunkSize = 3000;

export async function runDiff(operation: WorkspaceOperation, owner: Repository, args: readonly string[], paths: readonly string[],
  literalPaths: boolean, worktree: string) {
  const run = (command: readonly string[], stdin: Buffer | null) => gitProcess(operation.runtime.supervisor, owner.executable,
    worktree, command, operation.signal, { kind: 'diff', gitDirectory: owner.repository.gitDirectory.canonicalPath,
      worktree, literalPaths, stdin });
  const accepted = (result: Awaited<ReturnType<typeof run>>) => {
    if (result.code !== 0 && result.code !== 1) throw new WorkspaceFailure('gitQueryFailed', { exit: result.code });
    return gitText(result.bytes);
  };
  if (paths.reduce((count, path) => count + Buffer.byteLength(path) + 1, 0) >= pathspecByteLimit) {
    const result = await run([...args, '--pathspec-from-file=-', '--pathspec-file-nul'], Buffer.from(paths.join('\0') + '\0'));
    if (result.code === 0 || result.code === 1) return accepted(result);
    const message = gitText(result.stderr).toLowerCase();
    if (!message.includes('unknown option') && !message.includes('pathspec-from-file')) return accepted(result);
  }
  if (!paths.length) return accepted(await run(args, null));
  if (paths.length <= pathspecChunkSize) return accepted(await run([...args, '--', ...paths], null));
  let combined = '';
  for (let offset = 0; offset < paths.length; offset += pathspecChunkSize) {
    const text = accepted(await run([...args, '--', ...paths.slice(offset, offset + pathspecChunkSize)], null));
    if (text) combined += args.includes('-z') || text.endsWith('\n') ? text : text + '\n';
  }
  return combined;
}

async function resolveMainCompare(operation: WorkspaceOperation, owner: Repository, comparison: DiffCommands['comparison']): Promise<string | null> {
  if (comparison.kind !== 'revspec' && comparison.kind !== 'uncommitted' && comparison.kind !== 'staged') return null;
  const baseName = comparison.kind === 'revspec' ? comparison.spec : comparison.base;
  if (!/^(main|trunk)$/i.test(baseName)) return null;
  const run = async (args: string[]) => {
    const result = await gitProcess(operation.runtime.supervisor, owner.executable, owner.repository.worktree.canonicalPath,
      args, operation.signal, { kind: 'repository' });
    if (result.code !== 0) throw new WorkspaceFailure('gitQueryFailed', { exit: result.code });
    return gitText(result.bytes);
  };
  const branches = new Set((await run(['for-each-ref', '--format=%(refname:short)', '--count=200', 'refs/remotes']))
    .split('\n').concat((await run(['for-each-ref', '--format=%(refname:short)', '--count=200', 'refs/heads'])).split('\n')));
  let base = ['origin/main', 'upstream/main', 'main', 'origin/master', 'upstream/master', 'master'].find(ref => branches.has(ref));
  if (!base) {
    const result = await gitProcess(operation.runtime.supervisor, owner.executable, owner.repository.worktree.canonicalPath,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], operation.signal, { kind: 'repository' });
    if (result.code === 0) base = gitText(result.bytes).trim();
  }
  if (!base) throw new WorkspaceFailure('gitComparisonUnavailable');
  return (comparison.kind === 'staged' ? 'staged-mergebase:' : 'uncommitted-mergebase:') + base;
}

export async function readDiff(operation: WorkspaceOperation, request: DiffRequest, encode: ResultEncoding) {
  if (request.root === null) throw new WorkspaceFailure('gitTargetRequired');
  const owner = await resolveDiffRepository(operation, request.root, { kind: 'explicit', worktree: request.worktree });
  return readRepositoryDiff(operation, request, owner, encode);
}

export async function readElectedDiff(operation: WorkspaceOperation, request: DiffRequest, checkout: NativeGitCheckout, encode: ResultEncoding) {
  const owner = await resolveDiffRepository(operation, checkout.root, { kind: 'elected', checkout });
  return readRepositoryDiff(operation, { ...request, root: checkout.root }, owner, encode);
}

async function readRepositoryDiff(operation: WorkspaceOperation, request: DiffRequest, owner: Repository, encode: ResultEncoding) {
  const captured = await captureRepositoryDiff(operation, request, owner,
    request.detail.toLowerCase() === 'patches' || request.detail.toLowerCase() === 'full' ||
    [...(request.path === null ? [] : [request.path]), ...request.paths].filter(path => path.trim()).length === 1 && request.detail.toLowerCase() === 'summary');
  const projected = await operation.gitDiffOperation({ kind: 'projectGitDiff', compare: captured.commands.display, detail: request.detail,
    pathspecCount: captured.commands.inputCount, isMultiRepo: false, changedFiles: captured.content.changedFiles,
    perFilePatches: captured.content.perFile });
  const reply = { kind: 'git' as const, op: 'diff' as const, root: request.root, repository: captured.repository,
    diff: projected.diff, exclusions: captured.exclusions };
  const requiredBytes = serializedBytes(encode(reply));
  return requiredBytes <= request.maxOutputBytes ? reply : { kind: 'outputBudgetTooSmall' as const, requiredBytes };
}

export async function captureGitDiff(operation: WorkspaceOperation, request: DiffRequest, generateDiffText: boolean) {
  if (request.root === null) throw new WorkspaceFailure('gitTargetRequired');
  const owner = await resolveDiffRepository(operation, request.root, { kind: 'explicit', worktree: request.worktree });
  return captureRepositoryDiff(operation, request, owner, generateDiffText);
}

export async function captureElectedGitDiff(operation: WorkspaceOperation, request: DiffRequest,
  checkout: NativeGitCheckout, generateDiffText: boolean) {
  const owner = await resolveDiffRepository(operation, checkout.root, { kind: 'elected', checkout });
  return captureRepositoryDiff(operation, { ...request, root: checkout.root }, owner, generateDiffText);
}

async function captureRepositoryDiff(operation: WorkspaceOperation, request: DiffRequest, owner: Repository, generateDiffText: boolean) {
  const preparation = { kind: 'prepareGitDiff' as const, compare: request.compare,
    paths: [...(request.path === null ? [] : [request.path]), ...request.paths], repoRootPath: owner.repository.worktree.canonicalPath,
    contextLines: request.contextLines, detectRenames: request.detectRenames };
  let commands = await operation.gitDiffOperation(preparation);
  const resolved = await resolveMainCompare(operation, owner, commands.comparison);
  if (resolved !== null) commands = await operation.gitDiffOperation({ ...preparation, compare: resolved });
  else {
    const snapshot = await operation.resolveGitSnapshotComparison(owner.access.root('GitRepository').handle, request.compare);
    if (snapshot.kind === 'gitSnapshotComparisonError') throw new WorkspaceFailure(snapshot.code, { message: snapshot.message });
    commands = await operation.gitDiffOperation({ ...preparation, compare: snapshot.comparison });
  }
  const reference = commands.comparison.kind === 'unstaged' ? null : commands.comparison.kind === 'revspec'
    ? commands.comparison.spec : commands.comparison.base;
  if (reference?.startsWith('-')) throw new WorkspaceFailure('invalidRequest');
  const fingerprint = await captureGitFingerprint(operation, owner, commands);
  const exclusions: string[] = [];
  const authorize = (paths: readonly string[]) => paths.filter(path => {
    if (owner.permits(path)) return true;
    exclusions.push(path); return false;
  });
  const { tracked, untracked } = await discoverPaths(operation, owner, commands, authorize, exclusions);
  const workRoot = join(operation.runtime.options.cachePath, 'work'); await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(workRoot, 'scout-diff-'));
  try {
    const live = await usesWorktree(operation, owner, commands.comparison);
    const content = await captureDiffContent(operation, owner, request, commands, { tracked, untracked }, scratch, live,
      generateDiffText, fingerprint);
    await owner.revalidate();
    const repository = { worktree: owner.repository.worktree, gitDirectory: owner.repository.gitDirectory };
    return { commands, content, repository, exclusions: [...new Set(exclusions)] };
  } finally { await rm(scratch, { recursive: true }); }
}

async function captureDiffContent(operation: WorkspaceOperation, owner: Repository, request: DiffRequest, commands: DiffCommands,
  paths: { tracked: string[]; untracked: string[] }, scratch: string, live: boolean, generateDiffText: boolean,
  fingerprint: GitSnapshotContent['fingerprint']): Promise<GitSnapshotContent> {
  const { tracked, untracked } = paths;
  const materialized = await captureWorktree(operation, owner, scratch, live ? tracked : [], untracked);
  const workingDirectory = live ? materialized.trackedRoot : owner.repository.worktree.canonicalPath;
  const numstat = tracked.length ? await runDiff(operation, owner, commands.numstat, tracked, true, workingDirectory) : '';
  const nameStatus = tracked.length ? await runDiff(operation, owner, commands.nameStatus, tracked, true, workingDirectory) : '';
  const stats = await operation.gitDiffOperation({ kind: 'parseGitDiffStats', numstat: Buffer.from(numstat).toString('base64'),
    nameStatus: Buffer.from(nameStatus).toString('base64'), untracked: materialized.untracked });
  const changedFiles = commands.hasRelativeInputs || !commands.inputCount ? stats.files : stats.files.filter(file =>
    commands.paths.some(path => file.path === path.replace(/\/$/, '') || file.path.startsWith(path.endsWith('/') ? path : path + '/')));
  let diffText: string | null = null;
  let patches: Record<string, string> | null = null;
  if (changedFiles.length && generateDiffText) {
    const trackedPatch = tracked.length ? await runDiff(operation, owner, commands.patch, tracked, true, workingDirectory) : '';
    const untrackedPatch = await captureUntrackedPatch(operation, owner, materialized.untrackedRoot,
      changedFiles.some(file => file.status === '??'), scratch, request.contextLines);
    const combined = [trackedPatch, untrackedPatch].filter(Boolean).join('\n');
    if (combined) {
      diffText = combined;
      const parsed = await operation.gitDiffOperation({ kind: 'parseGitPatch', text: combined });
      patches = Object.fromEntries(parsed.files.map(file => [file.path, file.patch]));
    }
  }
  return { fingerprint, scope: commands.inputCount ? 'selected' : 'all', requestedPaths: commands.inputCount ? commands.paths : null,
    changedFiles, diffText, perFile: patches, summary: { files: changedFiles.length,
      insertions: changedFiles.reduce((count, file) => count + (file.additions ?? 0), 0),
      deletions: changedFiles.reduce((count, file) => count + (file.deletions ?? 0), 0) } };
}

export async function discoverPaths(operation: WorkspaceOperation, owner: Repository,
  commands: Pick<DiffCommands, 'inputCount' | 'pathspecs' | 'nameStatus' | 'includeUntracked'>,
  authorize: (paths: readonly string[]) => string[], exclusions: string[]) {
  if (commands.inputCount && !commands.pathspecs.length) return { tracked: [], untracked: [] };
  const names = await runDiff(operation, owner, [...commands.nameStatus.slice(0, 1), '-z', ...commands.nameStatus.slice(1)],
    commands.pathspecs, false, owner.repository.worktree.canonicalPath);
  const tracked: string[] = [];
  for (const endpoints of parseEndpoints(names)) {
    const allowed = authorize(endpoints);
    if (allowed.length === endpoints.length) tracked.push(...allowed);
    else exclusions.push(...endpoints);
  }
  let untracked: string[] = [];
  if (commands.includeUntracked) {
    const listed = await gitProcess(operation.runtime.supervisor, owner.executable, owner.repository.worktree.canonicalPath,
      ['ls-files', '--others', '--exclude-standard', ...(commands.pathspecs.length ? ['--', ...commands.pathspecs] : [])], operation.signal,
      { kind: 'diff', gitDirectory: owner.repository.gitDirectory.canonicalPath, worktree: owner.repository.worktree.canonicalPath,
        literalPaths: false, stdin: null });
    if (listed.code !== 0) throw new WorkspaceFailure('gitQueryFailed', { exit: listed.code });
    untracked = authorize(gitText(listed.bytes).split('\n').filter(Boolean));
  }
  return { tracked: [...new Set(tracked)], untracked };
}

function parseEndpoints(names: string): (readonly [string] | readonly [string, string])[] {
  if (names && !names.endsWith('\0')) throw new WorkspaceFailure('gitProtocolError');
  const fields = names ? names.slice(0, -1).split('\0') : [], endpoints: (readonly [string] | readonly [string, string])[] = [];
  for (let offset = 0; offset < fields.length;) {
    const status = fields[offset++], path = fields[offset++];
    if (!status || !path || !/^[A-Z][0-9]*$/.test(status)) throw new WorkspaceFailure('gitProtocolError');
    if (status.startsWith('R') || status.startsWith('C')) {
      const target = fields[offset++]; if (!target) throw new WorkspaceFailure('gitProtocolError');
      endpoints.push([path, target]);
    } else endpoints.push([path]);
  }
  return endpoints;
}

export async function captureWorktree(operation: WorkspaceOperation, owner: Repository, scratch: string, tracked: string[], untracked: string[]) {
  const trackedRoot = join(scratch, 'tracked'), untrackedRoot = join(scratch, 'untracked');
  await mkdir(trackedRoot); await mkdir(untrackedRoot); await mkdir(join(scratch, 'empty'));
  const read = async (path: string) => {
    try { return await owner.access.read({ root: 'GitRepository', path }, null); }
    catch (error) { if (error instanceof NativeFailure && error.code === 'notFound') return null; throw error; }
  };
  const copy = async (path: string, root: string, source: NonNullable<Awaited<ReturnType<typeof read>>>) => {
    const target = join(root, path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, source.bytes, { flag: 'wx', mode: 0o600 });
    await chmod(target, descriptorGitMode(source.fingerprint.mode) === '100755' ? 0o755 : 0o644);
  };
  for (const path of tracked) {
    const source = await read(path); if (source) await copy(path, trackedRoot, source);
  }
  for (const path of attributePaths(tracked)) {
    if (tracked.includes(path)) continue;
    if (!owner.permits(path)) throw new WorkspaceFailure('pathDenied');
    const source = await read(path); if (source) await copy(path, trackedRoot, source);
  }
  const records: { path: string; bytes: string | null }[] = [];
  for (const path of untracked) {
    const source = await read(path); if (source) await copy(path, untrackedRoot, source);
    records.push({ path, bytes: source ? source.bytes.toString('base64') : null });
  }
  return { trackedRoot, untrackedRoot, untracked: records };
}

/** A lone revision, including a root commit's ^! expansion, compares against live files. */
export async function usesWorktree(operation: WorkspaceOperation, owner: Repository, comparison: DiffCommands['comparison']) {
  if (comparison.kind === 'staged' || comparison.kind === 'stagedMergeBase') return false;
  if (comparison.kind !== 'revspec') return true;
  const result = await gitProcess(operation.runtime.supervisor, owner.executable, owner.repository.worktree.canonicalPath,
    ['rev-parse', '--revs-only', '--end-of-options', comparison.spec], operation.signal, { kind: 'repository' });
  if (result.code !== 0) throw new WorkspaceFailure('gitQueryFailed', { exit: result.code });
  const revisions = gitText(result.bytes).split('\n').filter(Boolean);
  if (revisions.some(revision => !/^\^?(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision))) throw new WorkspaceFailure('gitProtocolError');
  return revisions.length < 2;
}

function attributePaths(paths: readonly string[]): string[] {
  const attributes = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/'); parts.pop();
    for (let depth = 0; depth <= parts.length; depth++) attributes.add([...parts.slice(0, depth), '.gitattributes'].join('/'));
  }
  return [...attributes];
}

async function captureUntrackedPatch(operation: WorkspaceOperation, owner: Repository, root: string, present: boolean,
  scratch: string, contextLines: number) {
  if (!present) return '';
  const result = await gitProcess(operation.runtime.supervisor, owner.executable, root,
    ['diff', '--no-index', '--unified=' + contextLines, '--no-ext-diff', '--no-textconv', '--color=never', '--', '../empty', '.'],
    operation.signal, { kind: 'scratch', ceiling: scratch });
  if (result.code !== 0 && result.code !== 1) throw new WorkspaceFailure('gitQueryFailed', { exit: result.code });
  return (await operation.gitDiffOperation({ kind: 'normalizeGitUntrackedPatch', text: gitText(result.bytes) })).text;
}
