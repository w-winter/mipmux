import { extname } from 'node:path';
import type { InventoryEntry, SourcePath } from '../contracts/inventory.js';
import type { NativeAccess } from './source-access.js';
import type { ArtifactStore } from './artifact-store.js';
import { freeze, WorkspaceFailure } from './values.js';

export type FileEntry = Extract<InventoryEntry, { kind: 'file' }>;
type AcquiredSource = Awaited<ReturnType<NativeAccess['read']>>;

export function capturedFile(source: SourcePath, acquired: AcquiredSource, visibility: FileEntry['visibility']): FileEntry {
  const decoding = acquired.decoding.kind === 'decoded'
    ? { kind: 'decoded' as const, identity: acquired.decoding.identity, encoding: acquired.decoding.encoding }
    : { kind: 'undecodable' as const };
  return freeze({ kind: 'file', ...source, visibility, identity: acquired.identity, decoding,
    structural: acquired.key === null ? { kind: 'unsupported' as const } : { kind: 'pending' as const, key: acquired.key } });
}

export async function completeFile(access: NativeAccess, entry: FileEntry, acquired: AcquiredSource,
  artifacts: ArtifactStore, retainExtraction: () => () => Promise<void>, artifactBuildSignal: AbortSignal): Promise<FileEntry> {
  if (acquired.key === null) return entry;
  const key = acquired.key;
  const record = await artifacts.resolve(key, async () => {
    const release = retainExtraction();
    try {
      access.signal.throwIfAborted();
      // Observer cancellation does not cancel an admitted build; runtime shutdown does.
      const extracted = await access.bridge.request({ kind: 'extract', extension: extname(entry.path).slice(1),
        bytes: acquired.bytes.toString('base64'), expected: acquired.identity }, artifactBuildSignal);
      if (extracted.result.kind !== 'extracted') throw new WorkspaceFailure('nativeProtocolError');
      return extracted.result;
    } finally { void release(); }
  }, access.signal);
  return freeze({ ...entry, structural: { kind: 'artifact', key, record } });
}
