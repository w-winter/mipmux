import { readFile } from 'node:fs/promises';
import type { AuthOperationOptions, CredentialStore } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { sha256, WorkspaceFailure } from '../workspace/values.js';

type LockResult<T> = { result: T; next?: string };
interface StorageBackend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>, options?: AuthOperationOptions): Promise<T>;
}
interface StorageModule {
  FileAuthStorageBackend: new (path: string) => StorageBackend;
  AuthStorage: { fromStorage(backend: StorageBackend): CredentialStore };
}
const storageSourceSHA256 = '0b45029901579032b19273a1427f63b622df8e1aaf9ea185eb932c0d4898998c';
const storageTypesSHA256 = '6197ffc082ffe1ef47894168fea1a575175743eaaa078bb4664ea310115dc9a6';
const credentialValidator = Compile(Type.Record(Type.String(), Type.Union([
  Type.Object({ type: Type.Literal('api_key'), key: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(Type.String(), Type.String())) }),
  Type.Object({ type: Type.Literal('oauth'), access: Type.String(), refresh: Type.String(), expires: Type.Number() },
    { additionalProperties: true }),
])));

export function rejectCommands(value: unknown): void {
  if (typeof value === 'string' && value.trimStart().startsWith('!')) throw new WorkspaceFailure('executableConfiguration');
  if (value && typeof value === 'object') Object.values(value).forEach(rejectCommands);
}

function isStorageModule(value: unknown): value is StorageModule {
  if (!value || typeof value !== 'object' || !('FileAuthStorageBackend' in value) || !('AuthStorage' in value)) return false;
  const auth = value.AuthStorage;
  return typeof value.FileAuthStorageBackend === 'function' && typeof auth === 'function' &&
    'fromStorage' in auth && typeof auth.fromStorage === 'function';
}

/** Reuses the audited Pi 1.0.2 lock and persistence implementation before key resolution. */
export async function createCredentials(path: string, signal: AbortSignal): Promise<CredentialStore> {
  const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
  const moduleURL = new URL('./core/auth-storage.js', entry);
  const metadata: unknown = JSON.parse(await readFile(new URL('../package.json', entry), 'utf8'));
  if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || metadata.version !== '1.0.2' ||
      sha256(await readFile(moduleURL)) !== storageSourceSHA256 ||
      sha256(await readFile(new URL('./core/auth-storage.d.ts', entry))) !== storageTypesSHA256) {
    throw new WorkspaceFailure('unsupportedCredentialSDK');
  }
  const sdk: unknown = await import(moduleURL.href);
  if (!isStorageModule(sdk)) throw new WorkspaceFailure('unsupportedCredentialSDK');
  const file = new sdk.FileAuthStorageBackend(path);
  const check = (bytes: string | undefined) => {
    if (bytes === undefined) return;
    let data: unknown;
    try { data = JSON.parse(bytes); }
    catch { throw new WorkspaceFailure('invalidCredentialConfiguration'); }
    rejectCommands(data);
    if (!credentialValidator.Check(data)) throw new WorkspaceFailure('invalidCredentialConfiguration');
  };
  const storage = sdk.AuthStorage.fromStorage({
    withLock: fn => file.withLock(current => {
      check(current); const result = fn(current); check(result.next); return result;
    }),
    withLockAsync: (fn, options) => file.withLockAsync(async current => {
      check(current); const result = await fn(current); check(result.next); return result;
    }, options),
  });
  // AuthStorage can serve cached data after a read error when no signal is supplied.
  const options = (input?: AuthOperationOptions): AuthOperationOptions => ({
    signal: input?.signal ? AbortSignal.any([signal, input.signal]) : signal,
  });
  const credentials: CredentialStore = {
    read: (provider, input) => storage.read(provider, options(input)),
    list: input => storage.list(options(input)),
    modify: (provider, fn, input) => storage.modify(provider, fn, options(input)),
    delete: (provider, input) => storage.delete(provider, options(input)),
  };
  await credentials.list();
  return credentials;
}
