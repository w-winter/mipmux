import { mkdir, open, readFile, link, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { DescriptorFingerprint, type NativeResult } from '../contracts/native.js';
import { SHA256 } from '../contracts/workspace.js';
import { artifactValidator, ReusableFileEntry, type ArtifactRecord, type ArtifactKey,
  type InventorySnapshot } from '../contracts/inventory.js';
import { canonicalJSON, sha256, freeze, WorkspaceFailure } from './values.js';
import { observe } from './observe.js';

type Extracted = Extract<NativeResult, { kind: 'extracted' }>;
const closed = { additionalProperties: false };
/** A scanned file's entry with the descriptor fingerprint observed when the scan read it. */
const ReusableFile = Type.Object({ fingerprint: DescriptorFingerprint, entry: ReusableFileEntry }, closed);
export type ReusableFile = Static<typeof ReusableFile>;
const reuseValidator = Compile(Type.Object({ schemaVersion: Type.Literal(1), workspaceKey: SHA256, binding: SHA256,
  files: Type.Array(ReusableFile), recordSHA256: SHA256 }, closed));
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

  /** Saves the files a scan after a restart may reuse, with the binding of the native build and settings that produced them. */
  async publishReuse(key: string, binding: string, files: readonly ReusableFile[]): Promise<void> {
    const body = { schemaVersion: 1 as const, workspaceKey: key, binding, files };
    await this.#replaceWorkspaceRecord(key, 'reuse.json', canonicalJSON({ ...body, recordSHA256: sha256(canonicalJSON(body)) }));
  }

  /** The saved reusable files when they were saved under `binding`; null when the record is absent or has another binding. */
  async readReuse(key: string, binding: string): Promise<readonly ReusableFile[] | null> {
    let raw: string;
    try { raw = await readFile(join(this.#path, 'workspaces', key, 'reuse.json'), 'utf8'); }
    catch (error) { if (isAbsent(error)) return null; throw error; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw reuseCorrupt(key); }
    if (!reuseValidator.Check(value) || value.workspaceKey !== key) throw reuseCorrupt(key);
    const { recordSHA256, ...body } = value;
    if (sha256(canonicalJSON(body)) !== recordSHA256) throw reuseCorrupt(key);
    return value.binding === binding ? freeze(value.files) : null;
  }

  /** Replaces one record in a workspace's directory by syncing a private temporary file and renaming it into place. */
  async #replaceWorkspaceRecord(key: string, name: string, body: string): Promise<void> {
    const directory = join(this.#path, 'workspaces', key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, randomUUID() + '.tmp');
    try {
      await writePrivate(temporary, body);
      await rename(temporary, join(directory, name)); await syncDirectory(directory);
    } finally { await unlink(temporary).catch(error => { if (!isAbsent(error)) throw error; }); }
  }

  async invalidate(digest: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new WorkspaceFailure('invalidArtifactKey');
    if (this.#pending.has(digest)) throw artifactFailure('artifactBusy', digest);
    await unlink(this.#artifactPath(digest));
  }

  async invalidateReuse(key: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new WorkspaceFailure('invalidWorkspaceKey');
    await unlink(join(this.#path, 'workspaces', key, 'reuse.json'));
  }

  #artifactPath(digest: string): string { return join(this.#path, 'artifacts', digest.slice(0, 2), digest + '.json'); }
}

function artifactFailure(code: string, key: string): WorkspaceFailure {
  return new WorkspaceFailure(code, { target: { kind: 'artifact', key } });
}
function reuseCorrupt(key: string): WorkspaceFailure {
  return new WorkspaceFailure('cacheCorrupt', { target: { kind: 'reuse', key } });
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
