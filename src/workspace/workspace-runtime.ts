import type { BridgeClient } from '../native/bridge-client.js';
import type { InventorySnapshot } from '../contracts/inventory.js';
import { ArtifactStore } from './artifact-store.js';
import { scanInventory } from './inventory.js';
import { NativeAccess, type OpenRoot } from './source-access.js';
import type { PolicyDeclaration } from './root-policy.js';
import { WorkspaceFailure } from './values.js';

export class WorkspaceRuntime {
  readonly #controller = new AbortController();
  #references = 0;
  #requested = 0;
  #published = 0;
  #flight: Promise<void> | null = null;
  #snapshot: InventorySnapshot | null = null;
  #failure: unknown = null;
  #closing: Promise<void> | null = null;
  readonly #observers = new Set<{ target: number; resolve: (snapshot: InventorySnapshot) => void; reject: (error: unknown) => void }>();
  constructor(readonly key: string, readonly declaration: PolicyDeclaration, private roots: readonly OpenRoot[],
    private bridge: BridgeClient, readonly artifacts: ArtifactStore, readonly onClosed: () => void,
    readonly makeBridge: () => BridgeClient) {}

  retain(): () => Promise<void> {
    if (this.#closing) throw new WorkspaceFailure('workspaceClosed');
    this.#references++;
    let released = false;
    return async () => {
      if (released) return;
      released = true; this.#references--;
      if (this.#references === 0) await this.close();
    };
  }

  warm(): void { this.#requested++; this.#start(); }

  #start(): void {
    if (this.#flight || this.#closing) return;
    const recovering = this.bridge.retired;
    this.#failure = null;
    this.#flight = (async () => {
      if (recovering) await this.#reopen();
      while (this.#published < this.#requested) {
        const target = this.#requested;
        process.stderr.write(JSON.stringify({ level: 'info', event: 'inventoryStarted', workspaceKey: this.key, generation: target }) + '\n');
        const snapshot = await scanInventory(new NativeAccess(this.bridge, this.roots, this.#controller.signal),
          this.declaration, this.key, target, this.artifacts, () => this.retain());
        this.#controller.signal.throwIfAborted();
        this.#snapshot = snapshot; this.#published = target; this.#failure = null;
        for (const observer of this.#observers) {
          if (observer.target <= target) { this.#observers.delete(observer); observer.resolve(snapshot); }
        }
        process.stderr.write(JSON.stringify({ level: snapshot.enumeration.kind === 'complete' ? 'info' : 'warn',
          event: 'inventoryPublished', workspaceKey: this.key, generation: target, entries: snapshot.entries.length,
          enumeration: snapshot.enumeration.kind, inventoryDigest: snapshot.inventoryDigest }) + '\n');
      }
    })().catch(error => {
      this.#failure = error;
      for (const observer of this.#observers) observer.reject(error);
      this.#observers.clear();
      process.stderr.write(JSON.stringify({ level: this.#controller.signal.aborted ? 'info' : 'error', event: 'inventoryFailed',
        workspaceKey: this.key, generation: this.#requested,
        code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'inventoryFailed' }) + '\n');
    }).finally(() => {
      this.#flight = null;
      if (this.#observers.size || (this.#failure === null && this.#published < this.#requested)) this.#start();
    });
  }

  async #reopen(): Promise<void> {
    await this.bridge.close();
    this.#controller.signal.throwIfAborted();
    const bridge = this.makeBridge();
    try {
      const opened = await bridge.request({ kind: 'openRoots', roots: this.declaration.roots.map(root => ({
        name: root.name, absolutePath: root.identity.declaredPath, access: 'source', expected: root.identity })) }, this.#controller.signal);
      const output = this.declaration.outputRoot;
      await bridge.request({ kind: 'openRoots', roots: [{ name: 'output', absolutePath: output.declaredPath,
        access: 'output', expected: output }] }, this.#controller.signal);
      this.roots = opened.result.roots;
      this.bridge = bridge;
    } catch (error) { await bridge.close(); throw error; }
  }

  #wait(target: number, signal: AbortSignal): Promise<InventorySnapshot> {
    if (this.#snapshot && this.#published >= target) return Promise.resolve(this.#snapshot);
    return new Promise<InventorySnapshot>((resolve, reject) => {
      const finish = () => { this.#observers.delete(observer); signal.removeEventListener('abort', abort); };
      const observer = { target, resolve: (snapshot: InventorySnapshot) => { finish(); resolve(snapshot); },
        reject: (error: unknown) => { finish(); reject(error); } };
      const abort = () => observer.reject(new WorkspaceFailure('cancelled'));
      this.#observers.add(observer);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  async refresh(signal: AbortSignal): Promise<InventorySnapshot> {
    if (this.#closing) throw new WorkspaceFailure('workspaceClosed');
    signal.throwIfAborted();
    const target = ++this.#requested;
    const observed = this.#wait(target, signal);
    this.#start();
    return observed;
  }

  async current(signal: AbortSignal): Promise<InventorySnapshot> {
    if (this.#closing) throw new WorkspaceFailure('workspaceClosed');
    signal.throwIfAborted();
    if (this.#failure !== null) throw this.#failure;
    if (this.#flight) return this.#wait(this.#requested, signal);
    if (!this.#snapshot) throw new WorkspaceFailure('inventoryUnavailable');
    return this.#snapshot;
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#controller.abort();
      for (const observer of this.#observers) observer.reject(new WorkspaceFailure('workspaceClosed'));
      this.#observers.clear();
      await this.bridge.close(); await this.#flight;
      this.onClosed();
    })();
    return this.#closing;
  }
}

