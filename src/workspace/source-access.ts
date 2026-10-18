import { NativeFailure, type BridgeClient } from '../native/bridge-client.js';
import type { NativeHandle } from '../contracts/native.js';
import type { DirectoryRef, SourceIdentity } from '../contracts/workspace.js';
import type { AdmittedRoot, SourcePath } from '../contracts/inventory.js';
import { WorkspaceFailure } from './values.js';
import { unreadableFileCodes } from '../contracts/errors.js';

export interface OpenRoot extends AdmittedRoot { readonly handle: NativeHandle }
export function unavailableRootCode(error: NativeFailure) {
  switch (error.code) {
    case 'notFound': case 'permissionDenied': case 'rootChanged': case 'nonRegularFile': case 'symlink': case 'nativeIOFailed':
      return error.code;
    default: return null;
  }
}
export function unavailableFileCode(error: NativeFailure) {
  return unreadableFileCodes.find(code => code === error.code) ?? null;
}
/** Admits requested roots once per operation; native I/O rechecks each retained capability. */
export class NativeAccess {
  readonly #opened = new Map<string, OpenRoot>();
  constructor(readonly bridge: BridgeClient, readonly roots: readonly AdmittedRoot[], readonly signal: AbortSignal) {}
  root(name: string): AdmittedRoot {
    const root = this.roots.find(root => root.name === name);
    if (!root) throw new WorkspaceFailure('unknownRoot', { root: name });
    return root;
  }
  async openRoot(name: string): Promise<OpenRoot> {
    const existing = this.#opened.get(name);
    if (existing) return existing;
    const root = this.root(name);
    const opened = await this.#openRoot(root);
    this.#opened.set(name, opened);
    return opened;
  }
  /** Revalidates the physical root before serving captured graph data. */
  async validateRoot(name: string): Promise<void> { await this.#openRoot(this.root(name)); }
  /** Expected physical failures are observations; protocol, worker and cancellation failures propagate. */
  async rootAvailability(name: string) {
    try { await this.validateRoot(name); return { kind: 'available' as const }; }
    catch (error) {
      if (!(error instanceof NativeFailure)) throw error;
      const code = unavailableRootCode(error);
      if (code === null) throw error;
      return { kind: 'unavailable' as const, code };
    }
  }
  async #openRoot(root: AdmittedRoot): Promise<OpenRoot> {
    const opened = await this.bridge.request({ kind: 'openRoots', roots: [{ name: root.name,
      absolutePath: root.identity.declaredPath, access: 'source', expected: root.identity }] }, this.signal);
    const capability = opened.result.roots[0];
    if (!capability) throw new WorkspaceFailure('nativeProtocolError');
    return capability;
  }
  async list(root: string, directory: DirectoryRef) {
    return (await this.bridge.request({ kind: 'listDirectory', root: (await this.openRoot(root)).handle, directory }, this.signal)).entries;
  }
  async read(source: SourcePath, expected: SourceIdentity | null) {
    const reply = await this.bridge.request({ kind: 'readSource', root: (await this.openRoot(source.root)).handle, path: source.path, expected }, this.signal);

    return { bytes: reply.bytes, ...reply.result };
  }
}
