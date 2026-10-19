import { join, relative } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { gitValidator, type GitRequest, type GitResult } from '../contracts/git.js';
import { resolveGitCommit } from '../patches/local-git.js';
import { gitProcess } from '../patches/git-process.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { serializedBytes, identityEncoding, type ResultEncoding } from './output-budget.js';
import { captureWorktree, discoverPaths, readDiff, runDiff, usesWorktree } from './git-diff.js';
import { resolveDiffRepository } from './git-repository.js';
import { resolveReadRepositories } from './git-read-repositories.js';
import { prepareGitPublicationMetadata } from '../context/git-publication.js';
import type { NativeGitCheckout } from '../contracts/native.js';

type ReadRequest = Exclude<GitRequest, { op: 'diff' }>;
type ReadRepository = Awaited<ReturnType<typeof resolveReadRepositories>>[number];
type StatusRepository = Extract<GitResult, { repos: unknown }>['repos'][number];
type ReadMetadata = Pick<Extract<GitResult, { op: 'log' }>, 'kind' | 'root' | 'repository' | 'worktree' | 'warning'>;

export async function readGit(operation: WorkspaceOperation, request: GitRequest, encode: ResultEncoding = identityEncoding,
  elected: readonly NativeGitCheckout[] | null = null) {
  if (!gitValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  if (request.op === 'diff' && request.artifacts) throw new WorkspaceFailure('draftRequired');
  if (request.op === 'diff') return readDiff(operation, request, encode);
  if (!operation.runtime.options.git) throw new WorkspaceFailure('gitNotConfigured');
  const repositories = await resolveReadRepositories(operation, request, elected);
  const primary = repositories[0];
  if (!primary) throw new WorkspaceFailure('gitTargetRequired');
  const reply = request.op === 'status' && repositories.length > 1
    ? { kind: 'git' as const, op: 'status' as const, repos: await statusRepositories(operation, request, repositories) }
    : await readRepository(operation, request, primary, repositories.length > 1);
  for (const repository of repositories) await repository.owner.revalidate();
  const requiredBytes = serializedBytes(encode(reply));
  return requiredBytes <= request.maxOutputBytes ? reply : { kind: 'outputBudgetTooSmall' as const, requiredBytes };
}

async function statusRepositories(operation: WorkspaceOperation, request: Extract<ReadRequest, { op: 'status' }>,
  repositories: readonly ReadRepository[]) {
  const plan = await operation.gitDiffOperation({ kind: 'planGitPublication',
    repositories: repositories.map(repository => repository.checkout.checkoutRootPath), paths: [], pathspecs: [], scope: 'all' });
  const readStatus = async (repository: ReadRepository) => {
    const fields = { root: repository.checkout.root, repo_root: repository.checkout.checkoutRootPath,
      repo_key: repository.checkout.repoKey, repo_name: repository.name };
    try {
      const reply = await readRepository(operation, request, repository, false);
      if (reply.op !== 'status') throw new WorkspaceFailure('gitProtocolError');
      const row: Exclude<StatusRepository, { error: string }> = { ...fields, repository: reply.repository, status: reply.status };
      if (reply.worktree !== undefined) row.worktree = reply.worktree;
      return row;
    } catch (error) {
      operation.signal.throwIfAborted();
      if (!(error instanceof WorkspaceFailure && ['gitQueryFailed', 'gitStatusMalformed'].includes(error.code))) throw error;
      await repository.owner.revalidate();
      return { ...fields, error: error.code === 'gitStatusMalformed' ? String(error.details.message) : error.code };
    }
  };
  const repos: Awaited<ReturnType<typeof readStatus>>[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(plan.maxConcurrentRepositories, repositories.length) }, async () => {
    while (next < repositories.length) {
      operation.signal.throwIfAborted();
      const index = next++, repository = repositories[index];
      if (!repository) throw new WorkspaceFailure('gitProtocolError');
      repos[index] = await readStatus(repository);
    }
  });
  for (const worker of await Promise.allSettled(workers)) {
    if (worker.status === 'rejected') throw worker.reason;
  }
  return repos;
}

async function readRepository(operation: WorkspaceOperation, request: ReadRequest, target: ReadRepository, multiple: boolean) {
  const { owner, pathBase } = target;
  if ('path' in request && request.path !== null &&
      !owner.permits(relative(owner.repository.worktree.canonicalPath, join(pathBase, request.path)))) throw new WorkspaceFailure('pathDenied');
  const read = async (args: readonly string[]) => {
    const result = await gitProcess(operation.runtime.supervisor, owner.executable, owner.repository.worktree.canonicalPath,
      args, operation.signal, { kind: 'repository' });
    if (result.code !== 0) throw new WorkspaceFailure('gitQueryFailed', { exit: result.code });
    return result.bytes;
  };
  const projected = request.op === 'show' ? await readShow(operation, request, owner, read)
    : await readQuery(operation, request, pathBase, read);
  await owner.revalidate();
  if (projected.kind === 'gitStatusError') throw new WorkspaceFailure('gitStatusMalformed', { message: projected.message });
  const common = await readMetadata(operation, request, target, multiple);
  if (request.op === 'show' && projected.kind === 'gitShow') return { ...common, op: request.op, show: projected.show, exclusions: projected.exclusions };
  if (request.op === 'status' && projected.kind === 'gitStatus') return { ...common, op: request.op, status: projected.status };
  if (request.op === 'log' && projected.kind === 'gitLog') return { ...common, op: request.op, log: { commits: projected.commits } };
  if (request.op === 'blame' && projected.kind === 'gitBlame') return { ...common, op: request.op, blame: { path: request.path, lines: projected.lines } };
  throw new WorkspaceFailure('gitProtocolError');
}

async function readMetadata(operation: WorkspaceOperation, request: ReadRequest, target: ReadRepository, multiple: boolean): Promise<ReadMetadata> {
  const { checkout, owner } = target;
  const common: ReadMetadata = { kind: 'git', root: checkout.root,
    repository: { worktree: owner.repository.worktree, gitDirectory: owner.repository.gitDirectory } };
  const warnings: string[] = [];
  if (multiple) warnings.push(`Multiple repos detected; op '${request.op}' ran against ${target.name}. Provide one repositories entry to target a specific repo.`);
  if (checkout.kind === 'linkedWorktree') {
    const { worktree } = await prepareGitPublicationMetadata(operation, checkout, owner);
    if (worktree.worktree !== null) common.worktree = worktree.worktree;
    if (worktree.warning !== null) warnings.push(worktree.warning);
  }
  if (warnings.length) common.warning = warnings.join('\n');
  return common;
}

async function readQuery(operation: WorkspaceOperation, request: Exclude<GitRequest, { op: 'show' | 'diff' }>, root: string,
  read: (args: readonly string[]) => Promise<Buffer>) {
  const query = request.op === 'status' ? { op: request.op } : request.op === 'log' ? { op: request.op, count: request.count,
    path: request.path === null ? null : join(root, request.path) }
    : { op: request.op, path: join(root, request.path), lines: request.lines };
  const command = await operation.prepareGitRead({ kind: 'prepareGitRead', query });
  const bytes = await read(command.args);
  return operation.projectGitRead({ kind: 'projectGitRead', query, bytes: bytes.toString('base64') });
}
async function readShow(operation: WorkspaceOperation, request: Extract<GitRequest, { op: 'show' }>,
  owner: Awaited<ReturnType<typeof resolveDiffRepository>>,
  read: (args: readonly string[]) => Promise<Buffer>) {
  const command = await operation.prepareGitShow({ kind: 'prepareGitShow', ref: request.ref, detail: request.detail,
    contextLines: request.contextLines, detectRenames: request.detectRenames });
  if (command.kind === 'gitShowError') throw new WorkspaceFailure('invalidRequest', { message: command.message });
  const oid = await resolveGitCommit(command.ref, async args => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await read(args));
    if (!text.endsWith('\n')) throw new WorkspaceFailure('gitProtocolError');
    return text.slice(0, -1);
  });
  const metadataBytes = await read([...command.metadata, oid]);
  const metadata = await operation.parseGitShowMetadata({ kind: 'parseGitShowMetadata', bytes: metadataBytes.toString('base64') });
  if (metadata.kind === 'gitShowError') throw new WorkspaceFailure('gitShowMalformed', { message: metadata.message });
  const revspec = oid + '^!';
  const exclusions: string[] = [];
  const authorize = (paths: readonly string[]) => paths.filter(path => {
    if (owner.permits(path)) return true;
    exclusions.push(path); return false;
  });
  const { tracked } = await discoverPaths(operation, owner, { inputCount: 0, pathspecs: [],
    nameStatus: [...command.nameStatus, revspec], includeUntracked: false }, authorize, exclusions);
  const live = await usesWorktree(operation, owner, { kind: 'revspec', spec: revspec });
  const workRoot = join(operation.runtime.options.cachePath, 'work'); await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(workRoot, 'show-'));
  try {
    const materialized = await captureWorktree(operation, owner, scratch, live ? tracked : [], []);
    const workingDirectory = live ? materialized.trackedRoot : owner.repository.worktree.canonicalPath;
    const numstat = tracked.length ? await runDiff(operation, owner, [...command.numstat, revspec], tracked, true, workingDirectory) : '';
    const nameStatus = tracked.length ? await runDiff(operation, owner, [...command.nameStatus, revspec], tracked, true, workingDirectory) : '';
    const patch = command.patch === null ? null : tracked.length
      ? await runDiff(operation, owner, [...command.patch, revspec], tracked, true, workingDirectory) : '';
    const projected = await operation.projectGitShow({ kind: 'projectGitShow', detail: request.detail, metadata: metadata.commit,
      numstat: Buffer.from(numstat).toString('base64'), nameStatus: Buffer.from(nameStatus).toString('base64'),
      patch: patch === null ? null : Buffer.from(patch).toString('base64') });
    await owner.revalidate();
    return { ...projected, exclusions: [...new Set(exclusions)] };
  } finally { await rm(scratch, { recursive: true }); }
}
