import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { gitValidator, type GitRequest } from '../contracts/git.js';
import { directoryIdentity, resolveGitCommit } from '../patches/local-git.js';
import { gitProcess } from '../patches/git-process.js';
import { canonicalJSON, WorkspaceFailure } from '../workspace/values.js';
import { serializedBytes, identityEncoding, type ResultEncoding } from './output-budget.js';
import { captureWorktree, discoverPaths, readDiff, runDiff, usesWorktree } from './git-diff.js';
import { resolveDiffRepository } from './git-repository.js';

export async function readGit(operation: WorkspaceOperation, request: GitRequest, encode: ResultEncoding = identityEncoding) {
  if (!gitValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
  if (request.op === 'diff') return readDiff(operation, request, encode);
  const configured = operation.runtime.options.git;
  if (!configured) throw new WorkspaceFailure('gitNotConfigured');
  const root = operation.snapshot.roots.find(root => root.name === request.root);
  if (!root) throw new WorkspaceFailure('unknownRoot');
  if ('path' in request && request.path !== null) await operation.authorizeComparisonPath({ root: request.root, path: request.path });
  const run = async (cwd: string, args: readonly string[]) => {
    const result = await gitProcess(operation.runtime.supervisor, configured.executable, cwd, args, operation.signal, { kind: 'repository' });
    if (result.code !== 0) throw new WorkspaceFailure('gitQueryFailed', { exit: result.code });
    return result.bytes;
  };
  const identity = async (args: readonly string[]) => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await run(root.identity.canonicalPath, args));
    if (!text.endsWith('\n')) throw new WorkspaceFailure('gitProtocolError');
    return directoryIdentity(text.slice(0, -1));
  };
  const repository = { worktree: await identity(['rev-parse', '--show-toplevel']),
    gitDirectory: await identity(['rev-parse', '--absolute-git-dir']) };
  const read = (args: readonly string[]) => run(root.identity.canonicalPath, args);
  const projected = request.op === 'show' ? await readShow(operation, request, read)
    : await readQuery(operation, request, root.identity.canonicalPath, read);
  const current = { worktree: await identity(['rev-parse', '--show-toplevel']),
    gitDirectory: await identity(['rev-parse', '--absolute-git-dir']) };
  if (canonicalJSON(current) !== canonicalJSON(repository)) throw new WorkspaceFailure('gitRepositoryChanged');
  if (projected.kind === 'gitStatusError') throw new WorkspaceFailure('gitStatusMalformed', { message: projected.message });
  const common = { kind: 'git' as const, root: request.root, repository };
  const reply = projectReply();
  function projectReply() {
    if (request.op === 'show' && projected.kind === 'gitShow') return { ...common, op: request.op, show: projected.show, exclusions: projected.exclusions };
    if (request.op === 'status' && projected.kind === 'gitStatus') return { ...common, op: request.op, status: projected.status };
    if (request.op === 'log' && projected.kind === 'gitLog') return { ...common, op: request.op, log: { commits: projected.commits } };
    if (request.op === 'blame' && projected.kind === 'gitBlame') return { ...common, op: request.op, blame: { path: request.path, lines: projected.lines } };
    throw new WorkspaceFailure('gitProtocolError');
  }
  const requiredBytes = serializedBytes(encode(reply));
  return requiredBytes <= request.maxOutputBytes ? reply : { kind: 'outputBudgetTooSmall' as const, requiredBytes };
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
  const owner = await resolveDiffRepository(operation, request.root, null), exclusions: string[] = [];
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
