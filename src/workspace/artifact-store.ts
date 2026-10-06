import { mkdir, open, readFile, link, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeResult } from '../contracts/native.js';
import { artifactValidator, inventoryValidator, type ArtifactRecord, type ArtifactKey, type InventorySnapshot } from '../contracts/inventory.js';
import { canonicalJSON, sha256, freeze, WorkspaceFailure } from './values.js';
import { observe } from './observe.js';

type Extracted = Extract<NativeResult, { kind: 'extracted' }>;
function isAbsent(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function isExists(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'EEXIST'; }

export class ArtifactStore {
  readonly #path: string;
  readonly #pending = new Map<string, Promise<ArtifactRecord>>();
  constructor(cachePath: string) { this.#path = join(cachePath, 'v1'); }

  async read(key: ArtifactKey): Promise<ArtifactRecord | null> {
    let raw: string;
    try { raw = await readFile(this.#artifactPath(key.digest), 'utf8'); }
    catch (error) { if (isAbsent(error)) return null; throw error; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw artifactFailure('cacheCorrupt', key.digest); }
    if (!artifactValidator.Check(value)) throw artifactFailure('cacheCorrupt', key.digest);
    const { recordSHA256, ...body } = value;
    const bytes = Buffer.from(value.keyCanonicalBase64, 'base64');
    if (sha256(canonicalJSON(body)) !== recordSHA256 || value.keyDigest !== key.digest ||
        value.keyCanonicalBase64 !== key.canonicalBase64 || sha256(bytes) !== key.digest ||
        bytes.toString('base64') !== value.keyCanonicalBase64 || (value.outcome.kind === 'ready') !== ('projection' in value)) {
      throw artifactFailure('cacheCorrupt', key.digest);
    }
    return freeze(value);
  }

  async insert(result: Extracted): Promise<ArtifactRecord> {
    result = structuredClone(result);
    const body = { schemaVersion: 1 as const, keyCanonicalBase64: result.key.canonicalBase64, keyDigest: result.key.digest,
      outcome: result.outcome, ...(result.projection === null ? {} : { projection: result.projection }) };
    const record = { ...body, recordSHA256: sha256(canonicalJSON(body)) };
    if (!artifactValidator.Check(record) || (record.outcome.kind === 'ready') !== ('projection' in record) ||
        sha256(Buffer.from(record.keyCanonicalBase64, 'base64')) !== record.keyDigest) throw new WorkspaceFailure('invalidArtifact');
    const destination = this.#artifactPath(result.key.digest);
    const directory = join(this.#path, 'artifacts', result.key.digest.slice(0, 2));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, randomUUID() + '.tmp');
    try {
      await writePrivate(temporary, canonicalJSON(record));
      try { await link(temporary, destination); await syncDirectory(directory); }
      catch (error) { if (!isExists(error)) throw error; }
      const stored = await this.read(result.key);
      if (stored?.recordSHA256 !== record.recordSHA256) throw artifactFailure('cacheConflict', result.key.digest);
      return stored;
    } finally { await unlink(temporary).catch(error => { if (!isAbsent(error)) throw error; }); }
  }

  async resolve(key: ArtifactKey, loader: () => Promise<Extracted>, signal: AbortSignal): Promise<ArtifactRecord> {
    signal.throwIfAborted();
    const stored = await this.read(key);
    if (stored) return stored;
    const pending = this.#pending.get(key.digest);
    if (pending) return observe(pending, signal);
    const work = (async () => {
      const extracted = await loader();
      if (canonicalJSON(extracted.key) !== canonicalJSON(key)) throw new WorkspaceFailure('artifactKeyMismatch');
      return this.insert(extracted);
    })();
    this.#pending.set(key.digest, work);
    try { return await work; } finally { this.#pending.delete(key.digest); }
  }

  async publishMembership(snapshot: InventorySnapshot): Promise<void> {
    const directory = join(this.#path, 'workspaces', snapshot.workspaceKey);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, randomUUID() + '.tmp');
    try {
      await writePrivate(temporary, canonicalJSON(snapshot));
      await rename(temporary, join(directory, 'membership.json')); await syncDirectory(directory);
    } finally { await unlink(temporary).catch(error => { if (!isAbsent(error)) throw error; }); }
  }

  async readMembership(key: string): Promise<InventorySnapshot | null> {
    let raw: string;
    try { raw = await readFile(join(this.#path, 'workspaces', key, 'membership.json'), 'utf8'); }
    catch (error) { if (isAbsent(error)) return null; throw error; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new WorkspaceFailure('membershipCorrupt', { target: { kind: 'membership', key } }); }
    if (!inventoryValidator.Check(value) || value.workspaceKey !== key || inventoryDigest(value) !== value.inventoryDigest) {
      throw new WorkspaceFailure('membershipCorrupt', { target: { kind: 'membership', key } });
    }
    return freeze(value);
  }

  async invalidate(digest: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new WorkspaceFailure('invalidArtifactKey');
    if (this.#pending.has(digest)) throw artifactFailure('artifactBusy', digest);
    await unlink(this.#artifactPath(digest));
  }

  async invalidateMembership(key: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new WorkspaceFailure('invalidWorkspaceKey');
    await unlink(join(this.#path, 'workspaces', key, 'membership.json'));
  }

  #artifactPath(digest: string): string { return join(this.#path, 'artifacts', digest.slice(0, 2), digest + '.json'); }
}

function artifactFailure(code: string, key: string): WorkspaceFailure {
  return new WorkspaceFailure(code, { target: { kind: 'artifact', key } });
}

export function inventoryDigest(value: Omit<InventorySnapshot, 'inventoryDigest' | 'generation'>): string {
  return sha256(canonicalJSON({ schemaVersion: value.schemaVersion, workspaceKey: value.workspaceKey,
    roots: value.roots, outputRoot: value.outputRoot, policy: value.policy, entries: value.entries, processing: value.processing, enumeration: value.enumeration }));
}
async function writePrivate(path: string, body: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); }
}
