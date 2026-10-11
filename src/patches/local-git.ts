import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { RelativePath, type RootIdentity } from '../contracts/workspace.js';
import { descriptorGitMode, type GitMode, type PatchInput, type PatchReceipt } from '../contracts/patches.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { NativeFailure } from '../native/bridge-client.js';
import { canonicalJSON, compareBytes, sha256, WorkspaceFailure } from '../workspace/values.js';
import { gitProcess } from './git-process.js';
import { bytePairDiff, equalSides, type FileSide } from './byte-pair-diff.js';

type LocalInput = Extract<PatchInput, { kind: 'localPatch' }>;
interface Entry {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
}
const pathValidator = Compile(RelativePath);
function strict(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorkspaceFailure('invalidEncoding');
  }
}
export async function directoryIdentity(path: string): Promise<RootIdentity> {
  const canonicalPath = await realpath(path), info = await stat(canonicalPath, { bigint: true });
  if (!info.isDirectory()) throw new WorkspaceFailure('gitRepositoryChanged');
  return { declaredPath: path, canonicalPath, device: String(info.dev), inode: String(info.ino) };
}

export async function acquireLocalPatch(
  operation: WorkspaceOperation,
  input: LocalInput,
  previous: PatchReceipt | null = null,
) {
  const configured = operation.runtime.options.git;
  if (!configured) throw new WorkspaceFailure('gitNotConfigured');
  const root = operation.snapshot.roots.find((root) => root.name === input.root);
  if (!root) throw new WorkspaceFailure('unknownRoot');
  const cwd = root.identity.canonicalPath;
  const run = (args: readonly string[]) =>
    gitProcess(operation.runtime.supervisor, configured.executable, cwd, args, operation.signal, {
      kind: 'repository',
    });
  const read = async (args: readonly string[]) => {
    const result = await run(args);
    if (result.code !== 0 || result.diagnostics) {
      throw new WorkspaceFailure('gitAcquisitionFailed', { exit: result.code });
    }
    return result.bytes;
  };
  const line = async (args: readonly string[]) => {
    const text = strict(await read(args));
    if (!text.endsWith('\n')) throw new WorkspaceFailure('gitProtocolError');
    return text.slice(0, -1);
  };
  const worktree = await directoryIdentity(await line(['rev-parse', '--show-toplevel']));
  if (
    worktree.canonicalPath !== cwd || worktree.device !== root.identity.device || worktree.inode !== root.identity.inode
  ) throw new WorkspaceFailure('gitRepositoryChanged');
  const gitDirectory = await directoryIdentity(await line(['rev-parse', '--absolute-git-dir']));
  const headResult = await run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const head = headResult.code === 1 && !headResult.diagnostics && !headResult.bytes.length
    ? null
    : headResult.code === 0 && !headResult.diagnostics
    ? strict(headResult.bytes).trim()
    : (() => {
      throw new WorkspaceFailure('gitAcquisitionFailed');
    })();
  const resolveCommit = async (ref: string) => {
    const oid = await line(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new WorkspaceFailure('gitProtocolError');
    return oid;
  };
  const base = previous?.repository
    ? previous.repository.base
    : input.comparison.base.kind === 'empty'
    ? null
    : await resolveCommit(input.comparison.base.ref);
  const target = previous?.repository
    ? previous.repository.target
    : input.comparison.kind === 'commits'
    ? await resolveCommit(input.comparison.target)
    : null;
  const parse = (bytes: Buffer, index: boolean): Entry[] => {
    const text = strict(bytes);
    if (text && !text.endsWith('\0')) throw new WorkspaceFailure('gitProtocolError');
    return text
      ? text.slice(0, -1).split('\0').map((record) => {
        const match = /^(\d+) (?:blob |commit |tree )?([a-f0-9]+)(?: (\d+))?\t([\s\S]*)$/.exec(record);
        if (
          !match || !pathValidator.Check(match[4]) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(match[2]!)
        ) throw new WorkspaceFailure('gitProtocolError');
        if (
          (index && match[3] !== '0') || /^0+$/.test(match[2]!)
        ) throw new WorkspaceFailure('unsupportedComparisonEntry', { path: match[4] });
        return { mode: match[1]!, oid: match[2]!, path: match[4] };
      })
      : [];
  };
  const tree = async (oid: string | null) =>
    oid === null ? [] : parse(await read(['ls-tree', '-rz', '--full-tree', oid]), false);
  const baseEntries = await tree(base);
  const indexBytes = input.comparison.kind === 'commits' ? null : await read(['ls-files', '--stage', '-z']);
  const indexEntries = indexBytes === null ? [] : parse(indexBytes, true);
  const targets = input.comparison.kind === 'commits' ? await tree(target) : indexEntries;
  const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]));
  const targetByPath = new Map(targets.map((entry) => [entry.path, entry]));
  const evidenced = new Set<string>();
  const paths = new Set([...baseEntries, ...targets].map((entry) => entry.path));
  if (input.comparison.kind === 'worktree' && input.comparison.includeUntracked) {
    for (
      const path of await operation.comparisonFiles(input.root, input.scope.kind === 'paths' ? input.scope.paths : null)
    ) paths.add(path);
  }
  const receipt: PatchReceipt = {
    input,
    identity: { sha256: sha256(''), byteCount: 0 },
    coverage: [],
    targets: [],
    policies: [],
    exclusions: [],
    repository: {
      worktree: { ...worktree, declaredPath: root.identity.declaredPath },
      gitDirectory,
      head,
      base,
      target,
      indexDigest: input.comparison.kind === 'staged' ? sha256(indexBytes!) : null,
    },
  };
  const supported = (entry: Entry): entry is Entry & { readonly mode: GitMode } =>
    entry.mode === '100644' || entry.mode === '100755';
  const blob = async (entry: Entry | undefined): Promise<FileSide> => {
    if (!entry) return { kind: 'absent' };
    if (!supported(entry)) throw new WorkspaceFailure('unsupportedComparisonEntry', { path: entry.path });
    return { kind: 'file', bytes: await read(['cat-file', 'blob', entry.oid]), mode: entry.mode };
  };
  const chunks: Buffer[] = [];
  for (const path of [...paths].sort(compareBytes)) {
    if (
      input.scope.kind === 'paths' &&
      !input.scope.paths.some((prefix) => path === prefix || path.startsWith(prefix + '/'))
    ) continue;
    try {
      receipt.policies.push({ path, policy: await operation.authorizeComparisonPath({ root: input.root, path }) });
    } catch (error) {
      if (error instanceof WorkspaceFailure && error.code === 'pathDenied') {
        receipt.exclusions.push(path);
        continue;
      }
      throw error;
    }
    for (const entry of [baseByPath.get(path), targetByPath.get(path)]) {
      if (entry && !supported(entry)) throw new WorkspaceFailure('unsupportedComparisonEntry', { path });
    }
    const before = await blob(baseByPath.get(path));
    let after: FileSide;
    if (input.comparison.kind === 'worktree') {
      try {
        const source = await operation.readComparisonSource({ root: input.root, path });
        after = { kind: 'file', bytes: source.bytes, mode: descriptorGitMode(source.fingerprint.mode) };
      } catch (error) {
        if (!(error instanceof NativeFailure) || error.code !== 'notFound') throw error;
        after = { kind: 'absent' };
      }
    } else after = await blob(targetByPath.get(path));
    if (after.kind === 'file') {
      receipt.targets.push({
        path,
        identity: { sha256: sha256(after.bytes), byteCount: after.bytes.length },
        mode: after.mode,
      });
      evidenced.add(path);
    }
    if (equalSides(before, after)) continue;
    receipt.coverage.push(path);
    chunks.push(
      await bytePairDiff(
        operation.runtime.supervisor,
        configured.executable,
        join(operation.runtime.options.cachePath, 'v1/work'),
        path,
        before,
        after,
        operation.signal,
      ),
    );
  }
  // Supporting selections outside a restricted patch scope still need target-version evidence.
  if (input.comparison.kind !== 'worktree') {
    for (const entry of targets) {
      if (evidenced.has(entry.path) || !supported(entry)) continue;
      try {
        await operation.authorizeComparisonPath({ root: input.root, path: entry.path });
      } catch (error) {
        if (error instanceof WorkspaceFailure && error.code === 'pathDenied') continue;
        throw error;
      }
      const side = await blob(entry);
      if (side.kind !== 'file') throw new WorkspaceFailure('gitProtocolError');
      receipt.targets.push({
        path: entry.path,
        identity: { sha256: sha256(side.bytes), byteCount: side.bytes.length },
        mode: side.mode,
      });
    }
  }
  const bytes = Buffer.concat(chunks);
  strict(bytes);
  receipt.identity = { sha256: sha256(bytes), byteCount: bytes.length };
  if (previous && canonicalJSON(receipt) !== canonicalJSON(previous)) {
    throw new WorkspaceFailure('comparisonChanged', { id: input.id });
  }
  return { bytes, receipt };
}
