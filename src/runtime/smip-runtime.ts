import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { BridgeClient } from '../native/bridge-client.js';
import { ProcessSupervisor } from './process-supervisor.js';
import { workspaceSpecValidator, InventorySnapshot as InventorySchema, type WorkspaceSpec, type InventorySnapshot, type IgnoreSettings } from '../contracts/inventory.js';
import type { ContextBuildRequest } from '../contracts/context.js';
import type { NativeOperation, NativeHandle } from '../contracts/native.js';
import { DraftRuntime } from '../context/draft-runtime.js';
import { loadVerifiedBundle } from '../context/verify.js';
import { revalidateMaterials } from '../context/revalidate.js';
import { revalidateAutomaticReviewGit } from '../context/automatic-review-git.js';
import { ArtifactStore } from '../workspace/artifact-store.js';
import { WorkspaceRuntime } from '../workspace/workspace-runtime.js';
import { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { canonicalJSON, freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
import type { DiscoveryRunner } from '../discovery/runner.js';
import { ClientRuntime } from './client-runtime.js';
import { parseClipboard, preparedClipboardInput } from '../context/clipboard.js';
import { finalFileTreeInput } from '../context/final-tree.js';
import type { RootIdentity } from '../contracts/workspace.js';
import { observe } from '../workspace/observe.js';

interface GitSnapshotMutationAccess { readonly bridge: BridgeClient; readonly root: NativeHandle }
interface GitSnapshotMutationOwner { tail: Promise<void>; bridge: BridgeClient | null }

export interface RuntimeOptions {
  /** User-owned maximum packet allowance in utf8-21-over-80-v1 units; larger request allowances are rejected. */
  readonly contextBudgetUnits: number;
  readonly cachePath: string;
  readonly nativeExecutable: string;
  readonly nativeEnvironment: Readonly<Record<string, string>>;
  readonly terminationGraceMs: number;
  readonly credentialPaths: readonly string[];
  /** Omission selects the retained RPCE defaults; explicit values are captured per workspace. */
  readonly ignoreSettings?: IgnoreSettings;
  readonly git?: { readonly executable: string };
}

export class SmipRuntime {
  readonly supervisor: ProcessSupervisor;
  readonly artifacts: ArtifactStore;
  readonly #owners = new Map<string, WorkspaceRuntime>();
  readonly #operations = new Set<WorkspaceOperation>();
  readonly #admissions = new Set<Promise<unknown>>();
  readonly #drafts = new Set<DraftRuntime>();
  readonly #clients = new Set<ClientRuntime>();
  readonly #snapshotMutations = new Map<string, GitSnapshotMutationOwner>();
  readonly #shutdown = new AbortController();
  #closing: Promise<void> | null = null;
  constructor(readonly options: RuntimeOptions) {
    this.options = freeze(structuredClone(options));
    if (!Number.isSafeInteger(options.contextBudgetUnits) || options.contextBudgetUnits < 1) {
      throw new WorkspaceFailure('invalidContextBudget');
    }
    for (const path of [options.cachePath, options.nativeExecutable, ...options.credentialPaths, ...(options.git ? [options.git.executable] : [])]) {
      if (!isAbsolute(path)) throw new WorkspaceFailure('absoluteConfigurationRequired');
    }
    this.supervisor = new ProcessSupervisor({ terminationGraceMs: options.terminationGraceMs });
    this.artifacts = new ArtifactStore(options.cachePath);
  }
  makeBridge(): BridgeClient {
    return new BridgeClient({ executable: this.options.nativeExecutable, supervisor: this.supervisor, env: this.options.nativeEnvironment });
  }
  /** Serializes one output root on its runtime-owned worker/cache. A new request reopens a retired worker against the same root identity. */
  mutateGitSnapshots<T>(root: RootIdentity, signal: AbortSignal,
    mutation: (signal: AbortSignal, access: GitSnapshotMutationAccess) => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new WorkspaceFailure('runtimeClosed'));
    const combined = AbortSignal.any([signal, this.#shutdown.signal]);
    const identity = structuredClone(root);
    const key = canonicalJSON([identity.canonicalPath, identity.device, identity.inode]);
    let owner = this.#snapshotMutations.get(key);
    if (!owner) {
      owner = { tail: Promise.resolve(), bridge: null };
      this.#snapshotMutations.set(key, owner);
    }
    const captured = owner, previous = captured.tail;
    process.stderr.write(JSON.stringify({ level: 'debug', event: 'snapshotMutationQueued', outputKey: sha256(key) }) + '\n');
    const work = (async () => {
      await observe(previous, combined);
      combined.throwIfAborted();
      if (captured.bridge?.retired) {
        await captured.bridge.close();
        captured.bridge = null;
      }
      const bridge = captured.bridge ??= this.makeBridge();
      const opened = await bridge.request({ kind: 'openRoots', roots: [{ name: 'GitSnapshots', absolutePath: identity.declaredPath,
        access: 'output', expected: identity }] }, combined);
      const output = opened.result.roots[0];
      if (!output) throw new WorkspaceFailure('nativeProtocolError');
      combined.throwIfAborted();
      process.stderr.write(JSON.stringify({ level: 'debug', event: 'snapshotMutationAdmitted', outputKey: sha256(key),
        generation: output.handle.generation }) + '\n');
      return mutation(combined, { bridge, root: output.handle });
    })();
    const settled = Promise.allSettled([previous, work]).then(() => {});
    captured.tail = settled;
    this.#admissions.add(work);
    void work.then(() => this.#admissions.delete(work), () => this.#admissions.delete(work));
    return work;
  }
  /** Owns captured prompt/tree/clipboard rendering, including observations after workspace lease release. */
  renderPresentation<O extends Extract<NativeOperation, { kind: 'renderFileTree' | 'renderPreparedClipboard' | 'renderDiscoveryPrompt' | 'renderDiscoveryMessage' | 'renderAutomaticReviewGit' | 'calculateTokenStats' }>>(input: O, signal: AbortSignal) {
    if (this.#closing) return Promise.reject(new WorkspaceFailure('runtimeClosed'));
    const captured = structuredClone(input), combined = AbortSignal.any([signal, this.#shutdown.signal]);
    const work = (async () => {
      combined.throwIfAborted();
      const bridge = this.makeBridge();
      try { return (await bridge.request(captured, combined)).result; }
      finally { await bridge.close(); }
    })();
    this.#admissions.add(work);
    void work.then(() => this.#admissions.delete(work), () => this.#admissions.delete(work));
    return work;
  }
  createClient(runner: DiscoveryRunner | null): ClientRuntime {
    if (this.#closing) throw new WorkspaceFailure('runtimeClosed');
    const client = new ClientRuntime(this, runner, () => this.#clients.delete(client));
    this.#clients.add(client); return client;
  }

  declare(input: WorkspaceSpec, signal: AbortSignal): Promise<WorkspaceHandle> {
    if (this.#closing) return Promise.reject(new WorkspaceFailure('runtimeClosed'));
    const work = this.#declare(input, AbortSignal.any([signal, this.#shutdown.signal]));
    this.#admissions.add(work);
    void work.then(() => this.#admissions.delete(work), () => this.#admissions.delete(work));
    return work;
  }
  async #declare(input: WorkspaceSpec, signal: AbortSignal): Promise<WorkspaceHandle> {
    validateWorkspaceSpec(input);
    const spec = structuredClone(input);
    const cache = await this.#admitCache();
    const bridge = this.makeBridge();
    let adopted = false;
    try {
      const opened = await bridge.request({ kind: 'openRoots', roots: spec.roots.map(root => ({ ...root, access: 'source', expected: null })) }, signal);
      const output = await bridge.request({ kind: 'openRoots', roots: [{ name: 'output', absolutePath: spec.outputRoot, access: 'output', expected: null }] }, signal);

      const outputRoot = output.result.roots[0];
      if (!outputRoot) throw new WorkspaceFailure('nativeProtocolError');
      const roots = opened.result.roots.map(root => ({ name: root.name, identity: root.identity, handle: root.handle }));
      const declaration = freeze({ roots: roots.map(root => ({ name: root.name, identity: root.identity })), outputRoot: outputRoot.identity, exclusions: spec.exclusions,
        ignoreSettings: this.options.ignoreSettings ?? null,
        deniedAbsolutePaths: [cache, outputRoot.identity.canonicalPath, ...await protectedPaths(this.options.credentialPaths)] });
      const key = sha256(canonicalJSON({ ...declaration, inventorySchemaVersion: InventorySchema.properties.schemaVersion.const, policyImplementation: 'rpce-ignore-v1' }));
      signal.throwIfAborted();
      let owner = this.#owners.get(key);
      if (!owner) {
        await this.artifacts.readMembership(key);
        owner = await this.mutateGitSnapshots(outputRoot.identity, signal, async (combined, access) => {
          const existing = this.#owners.get(key);
          if (existing) return existing;
          const maintenance = await access.bridge.request({ kind: 'maintainGitSnapshots', root: access.root, action: { kind: 'opened' } }, combined);
          combined.throwIfAborted();
          process.stderr.write(JSON.stringify({ level: 'info', event: 'workspaceSnapshotMaintenanceCompleted', workspaceKey: key,
            outcome: maintenance.result.outcome }) + '\n');
          const admitted = new WorkspaceRuntime(key, declaration, roots, bridge, this.artifacts, () => this.#owners.delete(key),
            () => this.makeBridge(), this.#shutdown.signal);
          this.#owners.set(key, admitted); adopted = true;
          return admitted;
        });
      }
      const handle = new WorkspaceHandle(this, owner, owner.retain());
      if (adopted) owner.warm();
      return handle;
    } finally { if (!adopted) await bridge.close(); }
  }

  openOperation(owner: WorkspaceRuntime, signal: AbortSignal): Promise<WorkspaceOperation> {
    return this.#admitOperation(owner,signal,null);
  }
  #admitOperation(owner: WorkspaceRuntime, signal: AbortSignal, pinned: InventorySnapshot | null): Promise<WorkspaceOperation> {
    if (this.#closing) return Promise.reject(new WorkspaceFailure('runtimeClosed'));
    const work = this.#openOperation(owner, signal, pinned);
    this.#admissions.add(work);
    void work.then(() => this.#admissions.delete(work), () => this.#admissions.delete(work));
    return work;
  }
  async #openOperation(owner: WorkspaceRuntime, signal: AbortSignal, pinned: InventorySnapshot | null): Promise<WorkspaceOperation> {
    if (this.#closing) throw new WorkspaceFailure('runtimeClosed');
    const release = owner.retain();
    const combined = AbortSignal.any([signal, this.#shutdown.signal]);
    try {
      const snapshot = pinned ?? await owner.current(combined);
      const operation = new WorkspaceOperation(snapshot, owner.declaration, combined,
        this, async () => { this.#operations.delete(operation); await release(); }, (nextSignal, captured) => this.#admitOperation(owner, nextSignal, captured),
        { kind: 'workspace', owner });
      this.#operations.add(operation);
      return operation;
    } catch (error) { await release(); throw error; }
  }
  async #admitCache(): Promise<string> {
    await mkdir(this.options.cachePath, { recursive:true,mode:0o700 });
    const cache = await realpath(this.options.cachePath);
    if (((await stat(cache)).mode & 0o077) !== 0) throw new WorkspaceFailure('cacheNotPrivate');
    return cache;
  }
  verifyCurrentBundle(directory: string, signal: AbortSignal) {
    if (this.#closing) return Promise.reject(new WorkspaceFailure('runtimeClosed'));
    const work = this.#verifyCurrentBundle(directory,AbortSignal.any([signal,this.#shutdown.signal]));
    this.#admissions.add(work);
    void work.then(()=>this.#admissions.delete(work),()=>this.#admissions.delete(work));
    return work;
  }
  async #verifyCurrentBundle(directory: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const { verified,materials,fileTree,automaticGit,comparisonText: savedComparison } = freeze(await loadVerifiedBundle(directory, signal)), manifest = verified.manifest;
    validateWorkspaceSpec({ roots:manifest.inventory.roots.map(root=>({name:root.name,absolutePath:root.identity.declaredPath})),
      exclusions:manifest.exclusions,outputRoot:manifest.inventory.outputRoot.declaredPath });
    const cache = await this.#admitCache();
    signal.throwIfAborted();
    const declaration = freeze({ roots:manifest.inventory.roots,outputRoot:manifest.inventory.outputRoot,exclusions:manifest.exclusions,
      ignoreSettings:this.options.ignoreSettings ?? null,
      deniedAbsolutePaths:[...manifest.deniedAbsolutePaths.map(path=>resolve(path)),cache,
        ...await protectedPaths(this.options.credentialPaths)] });
    // Zero has no discovery sequence meaning; this operation never publishes membership or pagination.
    const verificationOnlyGeneration = 0;
    const snapshot = freeze({...manifest.inventory,generation:verificationOnlyGeneration});
    const operation = new WorkspaceOperation(snapshot,declaration,signal,this,
      async()=>{this.#operations.delete(operation);},()=>Promise.reject(new WorkspaceFailure('verificationOperationOnly')), { kind: 'verification' });
    this.#operations.add(operation);
    try {
      await revalidateMaterials(operation,materials);
      await revalidateAutomaticReviewGit(operation, manifest.request, materials, automaticGit);
      const tree = await this.renderPresentation(finalFileTreeInput(manifest.inventory, materials, manifest.codemapMode), signal);
      if (tree.tree !== fileTree.text) throw new WorkspaceFailure('presentationChanged');
      const input = { request: manifest.request, prompt: manifest.prompt,
        inventory: manifest.inventory, codemapMode: manifest.codemapMode, materials, fileTree,
        automaticAcquisition: { kind: 'settled' as const, outcomes: manifest.automaticCodemaps }, automaticGit };
      const clipboard = await this.renderPresentation(preparedClipboardInput(input), signal);
      let comparison: string;
      try { comparison = parseClipboard({ ...input, clipboard: clipboard.text, clipboardPreset: clipboard.preset,
        selectedGitDiffIds: clipboard.selectedGitDiffIds }).comparisonText; }
      catch (error) {
        if (error instanceof WorkspaceFailure && error.code === 'invalidClipboard') throw new WorkspaceFailure('presentationChanged');
        throw error;
      }
      if (canonicalJSON(manifest.clipboardPreset) !== canonicalJSON(clipboard.preset) || savedComparison !== comparison) throw new WorkspaceFailure('presentationChanged');
      return {...verified,kind:'currentVerified' as const};
    } finally { await operation.close(); }
  }
  async createDraft(owner: WorkspaceRuntime, request: ContextBuildRequest, signal: AbortSignal, acquiring: () => void = () => {}): Promise<DraftRuntime> {
    if (this.#closing) throw new WorkspaceFailure('runtimeClosed');
    const release = owner.retain();
    const work = (async () => {
      const combined = AbortSignal.any([signal, this.#shutdown.signal]);
      const snapshot = await owner.refresh(combined);
      acquiring();
      combined.throwIfAborted();
      // The draft's base operation pins the publication that satisfied its own barrier; its lifetime is runtime-owned.
      const operation = await this.#admitOperation(owner, this.#shutdown.signal, snapshot);
      try {
        const draft = await DraftRuntime.acquire(operation, request, combined, () => this.#drafts.delete(draft));
        combined.throwIfAborted(); this.#drafts.add(draft); return draft;
      } catch (error) { await operation.close(); throw error; }
    })().finally(release);
    this.#admissions.add(work);
    try { return await work; } finally { this.#admissions.delete(work); }
  }
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#shutdown.abort();
      const owners = Promise.allSettled([...this.#owners.values()].map(owner => owner.close()));
      const results = await Promise.allSettled([...this.#clients].map(client => client.close()));
      await Promise.allSettled([...this.#admissions]);
      results.push(...await Promise.allSettled([...this.#drafts].map(draft => draft.close())));
      results.push(...await Promise.allSettled([...this.#operations].map(operation => operation.close())));
      results.push(...await owners);
      results.push(...await Promise.allSettled([...this.#owners.values()].map(owner => owner.close())));
      results.push(...await Promise.allSettled([...this.#snapshotMutations.values()].flatMap(owner => owner.bridge ? [owner.bridge.close()] : [])));
      this.#snapshotMutations.clear();
      results.push(...await Promise.allSettled([this.supervisor.close()]));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return this.#closing;
  }
}

/** Declared denies plus the physical target each protected path names, established once at admission. */
async function protectedPaths(paths: readonly string[]): Promise<string[]> {
  const denied = new Set(paths.map(path => resolve(path)));
  for (const path of paths) denied.add(await physicalTarget(path));
  return [...denied];
}

/** Canonical path of an existing file, or its canonical existing ancestor joined with the absent plain-name remainder. */
async function physicalTarget(path: string): Promise<string> {
  const absent: string[] = [];
  for (let candidate = path; ; candidate = dirname(candidate)) {
    try { return join(await realpath(candidate), ...absent); }
    catch (error) {
      // Optional credential files can be absent; other failures propagate.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    // ENOENT from realpath can also describe a dangling symlink, whose target cannot establish a deny.
    let exists = true;
    try { await lstat(candidate); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      exists = false;
    }
    if (exists) throw new WorkspaceFailure('credentialPathUnresolvable', { path });
    const leaf = basename(candidate);
    if (candidate === '/' || leaf === '' || leaf === '.' || leaf === '..') throw new WorkspaceFailure('credentialPathUnresolvable', { path });
    absent.unshift(leaf);
  }
}

function validateWorkspaceSpec(spec: WorkspaceSpec): void {
  if (!workspaceSpecValidator.Check(spec) || new Set(spec.roots.map(root=>root.name)).size !== spec.roots.length ||
      spec.exclusions.some(rule=>!spec.roots.some(root=>root.name === rule.root))) throw new WorkspaceFailure('invalidWorkspace');
}

export class WorkspaceHandle {
  #closed = false;
  constructor(private readonly runtime: SmipRuntime, private readonly owner: WorkspaceRuntime, private readonly release: () => Promise<void>) {}
  #check(): void { if (this.#closed) throw new WorkspaceFailure('workspaceClosed'); }
  async refresh(signal: AbortSignal) {
    this.#check(); const release = this.owner.retain();
    try { return await this.owner.refresh(signal); } finally { await release(); }
  }
  async openOperation(signal: AbortSignal) { this.#check(); return this.runtime.openOperation(this.owner, signal); }
  async createDraft(request: ContextBuildRequest, signal: AbortSignal, acquiring: () => void = () => {}) { this.#check(); return this.runtime.createDraft(this.owner, request, signal, acquiring); }
  async close(): Promise<void> { if (!this.#closed) { this.#closed = true; await this.release(); } }
}
