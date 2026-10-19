import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import Type from 'typebox';
import type { GitRequest } from '../contracts/git.js';
import type { GitSnapshotPublicationOptions } from '../contracts/git-snapshot.js';
import type { NativeGitCheckout } from '../contracts/native.js';
import { gitProcess } from '../patches/git-process.js';
import { gitText, resolveDiffRepository } from '../exploration/git-repository.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { canonicalJSON, WorkspaceFailure } from '../workspace/values.js';
import type { captureElectedGitDiff } from '../exploration/git-diff.js';
import { NativeFailure } from '../native/bridge-client.js';
import { captureGitWorktreeReply } from './git-worktree.js';

type CapturedPublication = Awaited<ReturnType<typeof captureElectedGitDiff>> & { readonly checkout: NativeGitCheckout };
type Repository = Awaited<ReturnType<typeof resolveDiffRepository>>;
const manifestMetadata = Compile(Type.Object({ generatedAt: Type.String() }));

export async function prepareGitPublicationMetadata(operation: WorkspaceOperation, checkout: NativeGitCheckout, repository: Repository) {
  const metadata = await operation.projectNative({ kind: 'prepareGitPublicationMetadata', repoRoot: checkout.checkoutRootPath });
  const worktree = metadata.worktree === null ? { worktree: null, warning: null }
    : await captureGitWorktreeReply(operation, input => operation.projectNative(input), checkout, repository,
      metadata.worktree.mainWorktreeRoot, operation.signal);
  return { repository, metadata, worktree };
}

/** Writes ordered snapshot files, CURRENT and retention; later failures retain completed filesystem effects. */
export async function publishGitSnapshot(operation: WorkspaceOperation, captured: CapturedPublication,
  request: Extract<GitRequest, { op: 'diff' }>, options: GitSnapshotPublicationOptions, ownerID: string,
  admit: () => void, prepared: Awaited<ReturnType<typeof prepareGitPublicationMetadata>>) {
  const { repository, metadata, worktree } = prepared;
  if (canonicalJSON({ worktree: repository.repository.worktree, gitDirectory: repository.repository.gitDirectory }) !== canonicalJSON(captured.repository)) {
    throw new WorkspaceFailure('gitRepositoryChanged');
  }
  return operation.runtime.mutateGitSnapshots(operation.snapshot.outputRoot, operation.signal, async (signal, access) => {
    admit();
    const id = await access.bridge.request({ kind: 'resolveGitSnapshotID', root: access.root,
      repoKey: captured.checkout.repoKey, snapshotID: options.snapshotID }, signal);
    const graph = await gitProcess(operation.runtime.supervisor, repository.executable, repository.repository.worktree.canonicalPath,
      metadata.graphArguments, signal, { kind: 'repository' });
    if (graph.code !== 0) throw new WorkspaceFailure('gitQueryFailed', { exit: graph.code });
    await repository.revalidate();
    const rendered = await access.bridge.request({ kind: 'serializeGitSnapshot', input: { ...captured.content,
      snapshotID: id.result.snapshotID, repoKey: captured.checkout.repoKey, mode: options.mode,
      compare: captured.commands.display, compareInput: request.compare === captured.commands.display ? null : request.compare,
      contextLines: request.contextLines, detectRenames: request.detectRenames, commitGraph: gitText(graph.bytes).trim(),
      repoRoot: captured.checkout.checkoutRootPath, tabID: ownerID, worktree: metadata.worktree } }, signal);
    const opened = await access.bridge.request({ kind: 'beginGitSnapshot', root: access.root,
      repoKey: captured.checkout.repoKey, snapshotID: id.result.snapshotID }, signal);
    try {
      for (const file of rendered.result.files) await access.bridge.request({ kind: 'writeGitSnapshotFile', run: opened.result.run,
        path: file.path, bytes: file.bytes }, signal);
      await access.bridge.request({ kind: 'writeGitSnapshotCurrent', run: opened.result.run }, signal);
      const manifest = rendered.result.files.find(file => file.path === 'manifest.json');
      if (!manifest) throw new WorkspaceFailure('nativeProtocolError');
      const saved = manifestMetadata.Parse(JSON.parse(Buffer.from(manifest.bytes, 'base64').toString('utf8')));
      await access.bridge.request({ kind: 'maintainGitSnapshots', root: access.root, action: { kind: 'published',
        repoKey: captured.checkout.repoKey, snapshotID: id.result.snapshotID, generatedAt: saved.generatedAt } }, signal);
      const snapshotDir = 'repos/' + captured.checkout.repoKey + '/' + id.result.snapshotID;
      const observed: { path: string; bytes: string }[] = [];
      for (const path of ['MAP.txt', 'index/changed_lines.tsv', 'diff/all.patch', 'deep/hunks.jsonl', 'deep/changed_lines.tsv']) {
        try {
          const file = await access.bridge.request({ kind: 'readGitSnapshotFile', root: access.root,
            repoKey: captured.checkout.repoKey, snapshotID: id.result.snapshotID, path }, signal);
          observed.push({ path, bytes: file.result.bytes });
        } catch (error) {
          if (!(error instanceof NativeFailure && error.code === 'notFound')) throw error;
        }
      }
      const map = observed.find(file => file.path === 'MAP.txt');
      const projected = await access.bridge.request({ kind: 'projectGitArtifacts', snapshotDir,
        snapshotDirectoryPath: join(operation.snapshot.outputRoot.canonicalPath, '_git_data', snapshotDir),
        manifest: manifest.bytes, availablePaths: observed.map(file => file.path),
        mapBytes: map ? map.bytes : null, compareDisplay: captured.commands.display, mode: options.mode,
        inlineMap: options.inlineMap, inlineMode: options.inlineMode, inlineMaxLines: options.inlineMaxLines,
        autoSelectedPaths: [], ...worktree }, signal);
      if (projected.result.kind === 'gitArtifactProjectionError') throw new WorkspaceFailure('gitArtifactProjectionError', { message: projected.result.message });
      return { kind: 'single' as const, snapshotID: id.result.snapshotID, snapshotDir, checkout: captured.checkout,
        files: rendered.result.files, projection: projected.result };
    } finally {
      if (!access.bridge.retired) await access.bridge.request({ kind: 'finishGitSnapshot', run: opened.result.run }, new AbortController().signal);
    }
  });
}
