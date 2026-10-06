import type { BridgeClient } from '../native/bridge-client.js';
import type { NativeHandle } from '../contracts/native.js';
import type { DirectoryRef, SourceIdentity } from '../contracts/workspace.js';
import type { AdmittedRoot, SourcePath } from '../contracts/inventory.js';
import { WorkspaceFailure } from './values.js';

export interface OpenRoot extends AdmittedRoot { readonly handle: NativeHandle }
export class NativeAccess {
  constructor(readonly bridge: BridgeClient, readonly roots: readonly OpenRoot[], readonly signal: AbortSignal) {}
  root(name: string): OpenRoot {
    const root = this.roots.find(root => root.name === name);
    if (!root) throw new WorkspaceFailure('unknownRoot', { root: name });
    return root;
  }
  async list(root: string, directory: DirectoryRef) {
    return (await this.bridge.request({ kind: 'listDirectory', root: this.root(root).handle, directory }, this.signal)).entries;
  }
  async read(source: SourcePath, expected: SourceIdentity | null) {
    const reply = await this.bridge.request({ kind: 'readSource', root: this.root(source.root).handle, path: source.path, expected }, this.signal);

    return { bytes: reply.bytes, ...reply.result };
  }
}
