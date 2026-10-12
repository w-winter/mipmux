import type { BridgeClient } from '../native/bridge-client.js';
import type { InventorySnapshot, PolicySnapshot } from '../contracts/inventory.js';
import { ArtifactStore } from './artifact-store.js';
import { scanInventory } from './inventory.js';
import { NativeAccess, type OpenRoot } from './source-access.js';
import type { PolicyDeclaration } from './root-policy.js';
import { WorkspaceFailure } from './values.js';
import { entryKey, managedInventory, type ManagedRegistration } from './managed-inventory.js';
import type { FileEntry } from './inventory-file.js';
import { capturedFile, completeFile } from './inventory-file.js';
import { RootPolicy } from './root-policy.js';
import { NativeFailure } from '../native/bridge-client.js';

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
  readonly #managed = new Map<string, ManagedRegistration>();
  readonly #managedViews = new WeakMap<InventorySnapshot, { revision: number; snapshot: InventorySnapshot }>();
  #managedRevision = 0;
  constructor(readonly key: string, readonly declaration: PolicyDeclaration, private roots: readonly OpenRoot[],
    private bridge: BridgeClient, readonly artifacts: ArtifactStore, readonly onClosed: () => void,
    readonly makeBridge: () => BridgeClient) {}

  registeredSnapshot(base: InventorySnapshot): InventorySnapshot {
    if (!this.#managed.size) return base;
    const cached = this.#managedViews.get(base);
    if (cached?.revision === this.#managedRevision) return cached.snapshot;
    const snapshot = managedInventory(base, this.#managed.values());
    this.#managedViews.set(base, { revision: this.#managedRevision, snapshot });
    return snapshot;
  }

  registerExplicitFile(base: InventorySnapshot, entry: FileEntry, policy: PolicySnapshot): void {
    this.#controller.signal.throwIfAborted();
    const proposed = new Map(this.#managed).set(entryKey(entry), { entry, policy });
    managedInventory(base, proposed.values());
    this.#managed.set(entryKey(entry), { entry, policy });
    this.#managedRevision++;
  }

  completeExplicitFile(entry: FileEntry): void {
    this.#controller.signal.throwIfAborted();
    const registered = this.#managed.get(entryKey(entry));
    if (!registered || registered.entry.identity.sha256 !== entry.identity.sha256) throw new WorkspaceFailure('sourceChanged');
    this.#managed.set(entryKey(entry), { ...registered, entry });
    this.#managedRevision++;
  }

  async #refreshManaged(access: NativeAccess): Promise<void> {
    for (const [key, registered] of [...this.#managed]) {
      await this.#refreshRegistration(access, key, registered);
    }
  }
  async #refreshRegistration(access: NativeAccess, key: string, registered: ManagedRegistration): Promise<void> {
    const policy = new RootPolicy(this.declaration, access), source = { root: registered.entry.root, path: registered.entry.path };
    try {
      if (policy.denied(source)) throw new WorkspaceFailure('pathDenied', source);
      const discoverable = await policy.admitted(source, false);
      const acquired = await access.read(source, null);
      const entry = await completeFile(access, capturedFile(source, acquired, discoverable ? 'discoverable' : 'managedOnly'),
        acquired, this.artifacts, () => this.retain());
      access.signal.throwIfAborted();
      if (this.#managed.get(key) !== registered) throw new WorkspaceFailure('sourceChanged', source);
      this.#managed.set(key, { entry, policy: policy.snapshot() });
      this.#managedRevision++;
    } catch (error) {
      if (error instanceof NativeFailure && ['notFound', 'nonRegularFile', 'symlink'].includes(error.code) ||
        error instanceof WorkspaceFailure && error.code === 'pathDenied') {
        if (this.#managed.get(key) !== registered) throw new WorkspaceFailure('sourceChanged', source);
        this.#managed.delete(key); this.#managedRevision++;
      } else throw error;
    }
  }

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
        const access = new NativeAccess(this.bridge, this.roots, this.#controller.signal);
        const snapshot = await scanInventory(access,
          this.declaration, this.key, target, this.artifacts, () => this.retain());
        await this.#refreshManaged(access);
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
    if (this.#snapshot && this.#published >= target) return Promise.resolve(this.registeredSnapshot(this.#snapshot));
    return new Promise<InventorySnapshot>((resolve, reject) => {
      const finish = () => { this.#observers.delete(observer); signal.removeEventListener('abort', abort); };
      const observer = { target, resolve: (snapshot: InventorySnapshot) => {
        try { const registered = this.registeredSnapshot(snapshot); finish(); resolve(registered); }
        catch (error) { finish(); reject(error); }
      },
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
    return this.registeredSnapshot(this.#snapshot);
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

