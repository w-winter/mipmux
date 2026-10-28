import type { BridgeClient } from '../native/bridge-client.js';
import type { InventorySnapshot, PolicySnapshot } from '../contracts/inventory.js';
import { ArtifactStore } from './artifact-store.js';
import { scanInventory, type Reuse } from './inventory.js';
import { NativeAccess, unavailableRootCode, type OpenRoot } from './source-access.js';
import type { PolicyDeclaration } from './root-policy.js';
import { canonicalJSON, freeze, WorkspaceFailure } from './values.js';
import { entryKey, managedInventory, type ManagedRegistration } from './managed-inventory.js';
import type { FileEntry } from './inventory-file.js';
import { capturedFile, completeFile } from './inventory-file.js';
import { RootPolicy } from './root-policy.js';
import { NativeFailure } from '../native/bridge-client.js';
import { failureCode } from '../runtime/tool-result.js';
import type { CatalogedGitArtifact } from './git-artifact-catalog.js';
import { GitExclusions, type GitExclusionQuery } from './git-exclusions.js';

interface CodemapDemand {
  readonly controller: AbortController;
  readonly retains: Set<symbol>;
  readonly result: Promise<FileEntry>;
}

/** Whether a registered file's refresh failed because the file is gone, is no longer regular or is now denied. */
function managedSourceGone(failure: NativeFailure | WorkspaceFailure): boolean {
  return failure instanceof NativeFailure ? ['notFound', 'nonRegularFile', 'symlink'].includes(failure.code) : failure.code === 'pathDenied';
}

// RPCE WorkspaceFileContextStore's retained presentation records per root session.
const maximumRetainedCodemapPresentationsPerRoot = 64;

export class WorkspaceRuntime {
  readonly #controller = new AbortController();
  #references = 0;
  #requested = 0;
  #published = 0;
  #flight: Promise<void> | null = null;
  #snapshot: InventorySnapshot | null = null;
  #reusable: Reuse | null = null;
  #gitExclusions = GitExclusions.none;
  #failure: unknown = null;
  #closing: Promise<void> | null = null;
  readonly #observers = new Set<{ target: number; resolve: (snapshot: InventorySnapshot) => void; reject: (error: unknown) => void }>();
  readonly #managed = new Map<string, ManagedRegistration>();
  readonly #managedViews = new WeakMap<InventorySnapshot, { revision: number; snapshot: InventorySnapshot }>();
  readonly #codemapDemands = new Map<string, CodemapDemand>();
  readonly #codemapPresentations = new Map<string, Set<symbol>>();
  readonly #gitArtifacts = new Map<string, CatalogedGitArtifact>();
  #managedRevision = 0;
  constructor(readonly key: string, readonly declaration: PolicyDeclaration, private roots: readonly OpenRoot[],
    private bridge: BridgeClient, readonly artifacts: ArtifactStore, readonly onClosed: () => Promise<void>,
    readonly makeBridge: () => BridgeClient, readonly artifactBuildSignal: AbortSignal, readonly codeMapsGloballyDisabled: boolean,
    readonly queryGit: (signal: AbortSignal) => GitExclusionQuery) {}

  /** The untracked paths Git ignored when the latest published scan asked it, which admission uses until the next scan. */
  get gitExclusions(): GitExclusions { return this.#gitExclusions; }

  registerGitArtifact(entry: CatalogedGitArtifact): void {
    this.#controller.signal.throwIfAborted();
    this.#gitArtifacts.set(entry.artifact.absolutePath, freeze(structuredClone(entry)));
  }

  catalogedGitArtifact(path: string): CatalogedGitArtifact | null {
    this.#controller.signal.throwIfAborted();
    return this.#gitArtifacts.get(path) ?? null;
  }

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

  retainCodemap(entry: FileEntry, load: (signal: AbortSignal) => Promise<FileEntry>) {
    if (this.#closing) throw new WorkspaceFailure('workspaceClosed');
    const key = canonicalJSON([entry.root, entry.path, entry.identity, entry.structural]);
    let demand = this.#codemapDemands.get(key);
    if (!demand) {
      const controller = new AbortController();
      const result = Promise.resolve().then(() => load(AbortSignal.any([controller.signal, this.#controller.signal])));
      demand = { controller, retains: new Set(), result };
      this.#codemapDemands.set(key, demand);
      void result.catch(error => {
        if (this.#codemapDemands.get(key)?.result === result) this.#codemapDemands.delete(key);
        const cause = failureCode(error);
        process.stderr.write(JSON.stringify({ level: cause === 'cancelled' ? 'debug' : 'error', event: 'codemapDemandFailed',
          workspaceKey: this.key, root: entry.root, path: entry.path, cause }) + '\n');
      });
    }
    const owned = demand, retain = Symbol();
    owned.retains.add(retain);
    process.stderr.write(JSON.stringify({ level: 'debug', event: 'codemapDemandRetained', workspaceKey: this.key,
      root: entry.root, path: entry.path, retains: owned.retains.size }) + '\n');
    let releasing: Promise<void> | null = null;
    const release = () => releasing ??= (async () => {
      if (!owned.retains.delete(retain)) return;
      if (owned.retains.size) return;
      owned.controller.abort();
      if (this.#codemapDemands.get(key) === owned) this.#codemapDemands.delete(key);
      await Promise.allSettled([owned.result]);
      process.stderr.write(JSON.stringify({ level: 'debug', event: 'codemapDemandReleased', workspaceKey: this.key,
        root: entry.root, path: entry.path }) + '\n');
    })();
    return { result: owned.result, release };
  }

  /** Returns an idempotent release for one root presentation, or null at capacity; closed workspaces reject admission. */
  retainCodemapPresentation(root: string): (() => void) | null {
    if (this.#closing) throw new WorkspaceFailure('workspaceClosed');
    let records = this.#codemapPresentations.get(root);
    if (records && records.size >= maximumRetainedCodemapPresentationsPerRoot) {
      process.stderr.write(JSON.stringify({ level: 'warn', event: 'codemapRetainedPresentationLimitExceeded',
        workspaceKey: this.key, root, limit: maximumRetainedCodemapPresentationsPerRoot }) + '\n');
      return null;
    }
    if (!records) { records = new Set(); this.#codemapPresentations.set(root, records); }
    const owned = records, record = Symbol();
    owned.add(record);
    return () => {
      owned.delete(record);
      if (!owned.size && this.#codemapPresentations.get(root) === owned) this.#codemapPresentations.delete(root);
    };
  }

  /** Whether `error` came from the source's root being unavailable, which keeps a registration until the root returns. */
  async #rootUnavailable(access: NativeAccess, failure: NativeFailure, source: { readonly root: string; readonly path: string }): Promise<boolean> {
    if (unavailableRootCode(failure) === null) return false;
    const root = await access.rootAvailability(source.root);
    if (root.kind !== 'unavailable') return false;
    process.stderr.write(JSON.stringify({ level: 'warn', event: 'managedSourceRootUnavailable',
      workspaceKey: this.key, root: source.root, path: source.path, code: root.code }) + '\n');
    return true;
  }
  async #refreshManaged(access: NativeAccess, git: GitExclusions): Promise<void> {
    for (const [key, registered] of [...this.#managed]) {
      await this.#refreshRegistration(access, git, key, registered);
    }
  }
  async #refreshRegistration(access: NativeAccess, git: GitExclusions, key: string, registered: ManagedRegistration): Promise<void> {
    const policy = new RootPolicy(this.declaration, access, git), source = { root: registered.entry.root, path: registered.entry.path };
    try {
      if (policy.denied(source)) throw new WorkspaceFailure('pathDenied', source);
      const discoverable = await policy.admitted(source, false);
      const acquired = await access.read(source, null);
      const entry = await completeFile(access, capturedFile(source, acquired, discoverable ? 'discoverable' : 'managedOnly'),
        acquired, this.artifacts, () => this.retain(), this.artifactBuildSignal, this.codeMapsGloballyDisabled);
      access.signal.throwIfAborted();
      if (this.#managed.get(key) !== registered) throw new WorkspaceFailure('sourceChanged', source);
      this.#managed.set(key, { entry, policy: policy.snapshot() });
      this.#managedRevision++;
    } catch (error) {
      if (!(error instanceof NativeFailure || error instanceof WorkspaceFailure)) throw error;
      if (error instanceof NativeFailure && await this.#rootUnavailable(access, error, source)) return;
      if (!managedSourceGone(error)) throw error;
      if (this.#managed.get(key) !== registered) throw new WorkspaceFailure('sourceChanged', source);
      this.#managed.delete(key); this.#managedRevision++;
    }
  }

  retain(): () => Promise<void> {
    if (this.#closing) throw new WorkspaceFailure('workspaceClosed');
    this.#references++;
    let released = false;
    return async () => {
      if (released) return;
      released = true; this.#references--;
      if (this.#references === 0 && !this.#closing) await this.close();
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
        const { snapshot, reusable, gitExclusions } = await scanInventory(access, this.declaration, this.key, target, this.artifacts,
          () => this.retain(), this.artifactBuildSignal, this.codeMapsGloballyDisabled, this.#reusable, this.queryGit(this.#controller.signal));
        await this.#refreshManaged(access, gitExclusions);
        this.#controller.signal.throwIfAborted();
        this.#snapshot = snapshot; this.#reusable = reusable; this.#gitExclusions = gitExclusions; this.#published = target; this.#failure = null;
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
    if (this.#snapshot) return this.registeredSnapshot(this.#snapshot);
    if (this.#flight) return this.#wait(this.#requested, signal);
    throw new WorkspaceFailure('inventoryUnavailable');
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#controller.abort();
      const demands = [...this.#codemapDemands.values()];
      for (const demand of demands) demand.controller.abort();
      for (const observer of this.#observers) observer.reject(new WorkspaceFailure('workspaceClosed'));
      this.#observers.clear();
      await this.bridge.close(); await this.#flight;
      await Promise.allSettled(demands.map(demand => demand.result));
      this.#codemapDemands.clear();
      this.#codemapPresentations.clear();
      await this.onClosed();
    })();
    return this.#closing;
  }
}

