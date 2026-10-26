import { extname } from 'node:path';
import type { InventoryEntry, InventorySnapshot, SourcePath } from '../contracts/inventory.js';
import type { DirectoryRef } from '../contracts/workspace.js';
import type { DescriptorFingerprint } from '../contracts/native.js';
import { NativeFailure } from '../native/bridge-client.js';
import { ArtifactStore, inventoryDigest } from './artifact-store.js';
import { RootPolicy, type PolicyDeclaration } from './root-policy.js';
import { NativeAccess } from './source-access.js';
import { canonicalJSON, compareBytes, freeze, WorkspaceFailure } from './values.js';
import { capturedFile, completeFile, type FileEntry } from './inventory-file.js';

/** Files from the previous scan, keyed by `reusableKey`, with the descriptor fingerprint observed when each was read. */
export type ReusableFiles = ReadonlyMap<string, { readonly fingerprint: DescriptorFingerprint; readonly entry: FileEntry }>;
const reusableKey = (source: SourcePath) => source.root + '\0' + source.path;

/**
 * Scans the declared roots. A file whose listed descriptor fingerprint equals the one recorded when the previous scan read it,
 * and whose codemap record is still cached, keeps its previous entry without being read again, as RPCE trusts unchanged
 * file metadata; every other file is read. Returns the snapshot and the files the next scan may reuse.
 */
export async function scanInventory(access: NativeAccess, declaration: PolicyDeclaration, workspaceKey: string,
  generation: number, artifacts: ArtifactStore, retainExtraction: () => () => Promise<void>, artifactBuildSignal: AbortSignal,
  codeMapsGloballyDisabled: boolean, reusable: ReusableFiles): Promise<{ snapshot: InventorySnapshot; reusable: ReusableFiles }> {
  const description = (await access.bridge.request({ kind: 'describe' }, access.signal)).result;
  const supportedExtensions = new Set(description.extensions.map(entry => entry.extension));
  const policy = new RootPolicy(declaration, access);
  const entries: InventoryEntry[] = [];
  const failures: { root: string; directory: DirectoryRef; code: string }[] = [];
  const next = new Map<string, { fingerprint: DescriptorFingerprint; entry: FileEntry }>();
  async function reuse(source: SourcePath, listed: DescriptorFingerprint): Promise<FileEntry | null> {
    const previous = reusable.get(reusableKey(source));
    if (!previous || canonicalJSON(previous.fingerprint) !== canonicalJSON(listed)) return null;
    const structural = previous.entry.structural;
    if (structural.kind !== 'artifact') return previous.entry;
    const record = await artifacts.read(structural.key);
    return record === null ? null : freeze({ ...previous.entry, structural: { ...structural, record } });
  }
  async function acquire(source: SourcePath, listed: DescriptorFingerprint): Promise<void> {
    const reused = await reuse(source, listed);
    if (reused) { entries.push(reused); next.set(reusableKey(source), { fingerprint: listed, entry: reused }); return; }
    try {
      const acquired = await access.read(source, null);
      const entry = await completeFile(access, capturedFile(source, acquired, 'discoverable'), acquired, artifacts, retainExtraction,
        artifactBuildSignal, codeMapsGloballyDisabled);
      entries.push(entry); next.set(reusableKey(source), { fingerprint: acquired.fingerprint, entry });
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
      const children = await access.list(root, directory);
      for (const child of children) {
        access.signal.throwIfAborted();
        const source = { root, path: path ? path + '/' + child.name : child.name };
        if (policy.denied(source)) {
          entries.push({ kind: 'skipped', ...source, reason: 'policy' }); continue;
        }
        if (child.entryKind === 'symlink' || child.entryKind === 'other') {
          entries.push({ kind: 'skipped', ...source, reason: child.entryKind === 'symlink' ? 'symlink' : 'nonRegular' }); continue;
        }
        if (!await policy.admitted(source, child.entryKind === 'directory')) {
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
  return { snapshot, reusable: next };
}
