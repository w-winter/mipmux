import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { InventoryEntry, InventorySnapshot, SourcePath } from '../contracts/inventory.js';
import type { DirectoryRef } from '../contracts/workspace.js';
import type { DescriptorFingerprint, NativeResult } from '../contracts/native.js';
import { NativeFailure } from '../native/bridge-client.js';
import { ArtifactStore, inventoryDigest, type ReusableFile } from './artifact-store.js';
import { RootPolicy, type PolicyDeclaration } from './root-policy.js';
import { NativeAccess } from './source-access.js';
import { canonicalJSON, compareBytes, freeze, sha256, WorkspaceFailure } from './values.js';
import { capturedFile, completeFile, type FileEntry } from './inventory-file.js';

/** Files a later scan may reuse, keyed by `reusableKey`, and the binding of the native build and settings that produced them. */
export interface Reuse { readonly binding: string; readonly files: ReadonlyMap<string, ReusableFile> }
const reusableKey = (source: SourcePath) => source.root + '\0' + source.path;

/** Identifies what a file entry depends on besides the file: the native executable, its pipelines and the codemap setting. */
async function reuseBinding(access: NativeAccess, description: Extract<NativeResult, { kind: 'description' }>,
  codeMapsGloballyDisabled: boolean): Promise<string> {
  const executable = await stat(access.bridge.executable, { bigint: true });
  return sha256(canonicalJSON({ description, codeMapsGloballyDisabled,
    executable: [executable.dev, executable.ino, executable.size, executable.mtimeNs, executable.ctimeNs].map(String) }));
}

/** The entry as reuse keeps it: without an artifact record, which reuse reloads from the artifact store. */
function reusableFile(fingerprint: DescriptorFingerprint, entry: FileEntry): ReusableFile {
  const { structural } = entry;
  return { fingerprint, entry: { ...entry, structural: structural.kind === 'artifact' ? { kind: 'artifact', key: structural.key } : structural } };
}

/**
 * Scans the declared roots. A file whose listed descriptor fingerprint equals the one recorded when an earlier scan read it,
 * and whose codemap record is still cached, keeps its earlier entry without being read again, as RPCE trusts unchanged
 * file metadata; every other file is read. The first scan after a restart reuses the saved files when the native build and
 * settings that produced them are unchanged. Returns the snapshot and the files the next scan may reuse, and saves them.
 */
export async function scanInventory(access: NativeAccess, declaration: PolicyDeclaration, workspaceKey: string,
  generation: number, artifacts: ArtifactStore, retainExtraction: () => () => Promise<void>, artifactBuildSignal: AbortSignal,
  codeMapsGloballyDisabled: boolean, reusable: Reuse | null): Promise<{ snapshot: InventorySnapshot; reusable: Reuse }> {
  const description = (await access.bridge.request({ kind: 'describe' }, access.signal)).result;
  const supportedExtensions = new Set(description.extensions.map(entry => entry.extension));
  const binding = await reuseBinding(access, description, codeMapsGloballyDisabled);
  const previous = reusable === null
    ? new Map((await artifacts.readReuse(workspaceKey, binding)).map(file => [reusableKey(file.entry), file]))
    : reusable.binding === binding ? reusable.files : new Map<string, ReusableFile>();
  const policy = new RootPolicy(declaration, access);
  const entries: InventoryEntry[] = [];
  const failures: { root: string; directory: DirectoryRef; code: string }[] = [];
  const next = new Map<string, ReusableFile>();
  async function reuse(source: SourcePath, listed: DescriptorFingerprint): Promise<FileEntry | null> {
    const saved = previous.get(reusableKey(source));
    if (!saved || canonicalJSON(saved.fingerprint) !== canonicalJSON(listed)) return null;
    const { structural } = saved.entry;
    if (structural.kind !== 'artifact') return freeze({ ...saved.entry, structural });
    const record = await artifacts.read(structural.key);
    return record === null ? null : freeze({ ...saved.entry, structural: { ...structural, record } });
  }
  async function acquire(source: SourcePath, listed: DescriptorFingerprint): Promise<void> {
    const reused = await reuse(source, listed);
    if (reused) { entries.push(reused); next.set(reusableKey(source), reusableFile(listed, reused)); return; }
    try {
      const acquired = await access.read(source, null);
      const entry = await completeFile(access, capturedFile(source, acquired, 'discoverable'), acquired, artifacts, retainExtraction,
        artifactBuildSignal, codeMapsGloballyDisabled);
      entries.push(entry); next.set(reusableKey(source), reusableFile(acquired.fingerprint, entry));
    } catch (error) {
      if (!(error instanceof NativeFailure) || ['cancelled', 'nativeWorkerClosed', 'nativeProtocolError'].includes(error.code)) throw error;
      const supported = supportedExtensions.has(extname(source.path).slice(1).toLowerCase());
      const structural: Extract<InventoryEntry, { kind: 'acquisitionFailed' }>['structural'] = !supported
        ? { kind: 'unsupported' } : error.code === 'nonRegularFile' || error.code === 'symlink'
          ? { kind: 'excluded', reason: 'nonRegular' } : { kind: 'pending' };
      entries.push({ kind: 'acquisitionFailed', ...source, code: error.code, structural });
    }
  }
  async function walk(root: string, path: string): Promise<void> {
    const directory: DirectoryRef = path ? { kind: 'descendant', path } : { kind: 'root' };
    try {
      if (!path && !await policy.admitted({ root, path: '' }, true)) return;
      await policy.directory(root, path);
      const children = (await access.list(root, directory)).map(child => ({ child, source: { root, path: path ? path + '/' + child.name : child.name } }));
      // Admission is decided for every regular file and directory at once, with one ignore query per root.
      const candidates = children.filter(({ child, source }) => !policy.denied(source) && (child.entryKind === 'file' || child.entryKind === 'directory'));
      const verdicts = await policy.admittedAll(candidates.map(({ child, source }) => ({ source, directory: child.entryKind === 'directory' })));
      const admitted = new Set(candidates.filter((_, index) => verdicts[index]).map(({ child }) => child));
      for (const { child, source } of children) {
        access.signal.throwIfAborted();
        if (policy.denied(source)) {
          entries.push({ kind: 'skipped', ...source, reason: 'policy' }); continue;
        }
        if (child.entryKind === 'symlink' || child.entryKind === 'other') {
          entries.push({ kind: 'skipped', ...source, reason: child.entryKind === 'symlink' ? 'symlink' : 'nonRegular' }); continue;
        }
        if (!admitted.has(child)) {
          entries.push({ kind: 'skipped', ...source, reason: 'policy' }); continue;
        }
        if (child.entryKind === 'directory') {
          entries.push({ kind: 'directory', ...source, visibility: 'discoverable' }); await walk(root, source.path); continue;
        }
        await acquire(source, child.fingerprint);
      }
    } catch (error) {
      if (!(error instanceof NativeFailure || error instanceof WorkspaceFailure) ||
          ['cancelled', 'nativeWorkerClosed', 'nativeProtocolError', 'cacheCorrupt', 'cacheConflict'].includes(error.code)) throw error;
      failures.push({ root, directory, code: error.code });
    }
  }
  for (const root of declaration.roots) await walk(root.name, '');
  entries.sort((a, b) => compareBytes(a.root, b.root) || compareBytes(a.path, b.path));
  const body = { schemaVersion: 5 as const, decoderPolicy: description.decoderPolicy, workspaceKey, roots: [...declaration.roots], outputRoot: declaration.outputRoot, policy: policy.snapshot(), entries,
    generation, processing: 'settled' as const,
    enumeration: failures.length ? { kind: 'incomplete' as const, failures } : { kind: 'complete' as const } };
  const snapshot = freeze({ ...body, inventoryDigest: inventoryDigest(body) });
  access.signal.throwIfAborted();
  await artifacts.publishMembership(snapshot);
  await artifacts.publishReuse(workspaceKey, binding, [...next.values()]);
  return { snapshot, reusable: { binding, files: next } };
}
