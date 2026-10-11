import { extname } from 'node:path';
import type { InventoryEntry, InventorySnapshot, SourcePath } from '../contracts/inventory.js';
import type { DirectoryRef } from '../contracts/workspace.js';
import { NativeFailure } from '../native/bridge-client.js';
import { ArtifactStore, inventoryDigest } from './artifact-store.js';
import { RootPolicy, type PolicyDeclaration } from './root-policy.js';
import { NativeAccess } from './source-access.js';
import { compareBytes, freeze, WorkspaceFailure } from './values.js';

export async function scanInventory(access: NativeAccess, declaration: PolicyDeclaration, workspaceKey: string,
  generation: number, artifacts: ArtifactStore, retainExtraction: () => () => Promise<void>): Promise<InventorySnapshot> {
  const description = (await access.bridge.request({ kind: 'describe' }, access.signal)).result;
  const supportedExtensions = new Set(description.extensions.map(entry => entry.extension));
  const policy = new RootPolicy(declaration, access);
  const entries: InventoryEntry[] = [];
  const failures: { root: string; directory: DirectoryRef; code: string }[] = [];
  async function acquire(source: SourcePath): Promise<void> {
    try {
      const acquired = await access.read(source, null);
      let structural: Extract<InventoryEntry, { kind: 'file' }>['structural'];
      if (acquired.key === null) structural = { kind: 'unsupported' };
      else {
        const key = acquired.key;
        const record = await artifacts.resolve(key, async () => {
          const release = retainExtraction();
          try {
            const extracted = await access.bridge.request({ kind: 'extract', extension: extname(source.path).slice(1),
              bytes: acquired.bytes.toString('base64'), expected: acquired.identity }, access.signal);
            if (extracted.result.kind !== 'extracted') throw new WorkspaceFailure('nativeProtocolError');
            return extracted.result;
          } finally {
            // Final release may join this scan; the workspace owner tracks that closure.
            void release();
          }
        }, access.signal);
        structural = { kind: 'artifact', key, record };
      }
      entries.push({ kind: 'file', ...source, identity: acquired.identity, structural });
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
          entries.push({ kind: 'directory', ...source }); await walk(root, source.path); continue;
        }
        await acquire(source);
      }
    } catch (error) {
      if (!(error instanceof NativeFailure || error instanceof WorkspaceFailure) ||
          ['cancelled', 'nativeWorkerClosed', 'nativeProtocolError', 'cacheCorrupt', 'cacheConflict'].includes(error.code)) throw error;
      failures.push({ root, directory, code: error.code });
    }
  }
  for (const root of declaration.roots) {
    if (await policy.admitted({ root: root.name, path: '' }, true)) await walk(root.name, '');
  }
  entries.sort((a, b) => compareBytes(a.root, b.root) || compareBytes(a.path, b.path));
  const body = { schemaVersion: 2 as const, workspaceKey, roots: [...declaration.roots], outputRoot: declaration.outputRoot, policy: policy.snapshot(), entries,
    generation, processing: 'settled' as const,
    enumeration: failures.length ? { kind: 'incomplete' as const, failures } : { kind: 'complete' as const } };
  const snapshot = freeze({ ...body, inventoryDigest: inventoryDigest(body) });
  access.signal.throwIfAborted();
  await artifacts.publishMembership(snapshot);
  return snapshot;
}
