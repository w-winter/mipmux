import type { InventorySnapshot, SourcePath, PolicySnapshot } from '../contracts/inventory.js';
import type { ReadRequest, TreeRequest, StructureRequest, SearchRequest } from '../contracts/exploration.js';
import type { BridgeClient } from '../native/bridge-client.js';
import type { SmipRuntime } from '../runtime/smip-runtime.js';
import { NativeAccess } from './source-access.js';
import { RootPolicy, type PolicyDeclaration } from './root-policy.js';
import { WorkspaceFailure } from './values.js';
import { readFile } from '../exploration/read.js';
import { getFileTree } from '../exploration/tree.js';
import { getCodeStructure } from '../exploration/structure.js';
import { readGit } from '../exploration/git.js';
import type { GitRequest } from '../contracts/git.js';
import { fileSearch } from '../exploration/search.js';
import type { ResultEncoding } from '../exploration/output-budget.js';
import type { NativeOperation } from '../contracts/native.js';

/** Pins one inventory and owns a separate bridge until close joins admitted operations. */
export class WorkspaceOperation {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  #access: Promise<NativeAccess> | null = null;
  #bridge: BridgeClient | null = null;
  readonly #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | null = null;
  constructor(readonly snapshot: InventorySnapshot, readonly declaration: PolicyDeclaration,
    signal: AbortSignal,
    readonly runtime: SmipRuntime, readonly release: () => Promise<void>, private readonly openPinned: (signal: AbortSignal) => Promise<WorkspaceOperation>) { this.signal = AbortSignal.any([signal, this.#controller.signal]); }
  fork(signal: AbortSignal): Promise<WorkspaceOperation> { this.#check(); return this.openPinned(signal); }
  validateRoots() {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      await access.bridge.request({ kind: 'openRoots', roots: this.snapshot.roots.map(root => ({ name: root.name,
        absolutePath: root.identity.declaredPath, access: 'source', expected: root.identity })) }, this.signal);
      const output = this.snapshot.outputRoot;
      await access.bridge.request({ kind:'openRoots',roots:[{ name:'output',absolutePath:output.declaredPath,access:'output',expected:output }] },this.signal);
    });
  }
  authorizeComparisonPath(source: SourcePath, previous: PolicySnapshot | null = null) {
    source = structuredClone(source);
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      const policy = new RootPolicy(this.declaration, access);
      if (previous) await policy.revalidate(source, previous);
      if (!await policy.admitted(source, false)) throw new WorkspaceFailure('pathDenied', source);
      return policy.snapshot();
    });
  }
  readComparisonSource(source: SourcePath) {
    source = structuredClone(source);
    return this.#track(async () => {
      await this.authorizeComparisonPath(source);
      const access = await (this.#access ??= this.#openAccess());
      return access.read(source, null);
    });
  }
  comparisonFiles(root: string, prefixes: readonly string[] | null) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      const policy = new RootPolicy(this.declaration, access), paths: string[] = [];
      const walk = async (path: string): Promise<void> => {
        await policy.directory(root, path);
        for (const entry of await access.list(root, path ? { kind: 'descendant', path } : { kind: 'root' })) {
          const child = path ? path + '/' + entry.name : entry.name, source = { root, path: child };
          if (prefixes && !prefixes.some(prefix=>child === prefix || child.startsWith(prefix+'/') || entry.entryKind === 'directory' && prefix.startsWith(child+'/'))) continue;
          if (!await policy.admitted(source, entry.entryKind === 'directory')) continue;
          if (entry.entryKind === 'directory') await walk(child);
          else if (entry.entryKind === 'file') paths.push(child);
          else throw new WorkspaceFailure('unsupportedComparisonEntry', source);
        }
      };
      await walk(''); return paths;
    });
  }
  async #openAccess(): Promise<NativeAccess> {
    const bridge = this.runtime.makeBridge(); this.#bridge = bridge;
    const opened = await bridge.request({ kind: 'openRoots', roots: this.snapshot.roots.map(root => ({ name: root.name,
      absolutePath: root.identity.declaredPath, access: 'source', expected: root.identity })) }, this.signal);

    return new NativeAccess(bridge, opened.result.roots, this.signal);
  }
  #check(): void {
    if (this.#closing) throw new WorkspaceFailure('operationClosed');
    if (this.signal.aborted) throw new WorkspaceFailure('cancelled');
  }
  async #track<T>(work: () => Promise<T>): Promise<T> {
    this.#check();
    const pending = work(); this.#pending.add(pending);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
    return pending;
  }
  readRawSource(source: SourcePath) {
    source = structuredClone(source);
    return this.#track(async () => {
      const entry = this.snapshot.entries.find(entry => entry.root === source.root && entry.path === source.path);
      if (!entry || entry.kind !== 'file') throw new WorkspaceFailure('unavailableSource', source);
      const access = await (this.#access ??= this.#openAccess());
      const policy = new RootPolicy(this.declaration, access);
      await policy.revalidate(source, this.snapshot.policy);
      return access.read(source, entry.identity);
    });
  }
  readSource(source: SourcePath) {
    source = structuredClone(source);
    return this.#track(async () => {
      const acquired = await this.readRawSource(source);
      if (acquired.decoding.kind !== 'decoded') throw new WorkspaceFailure('decodeFailed', source);
      const entry = this.snapshot.entries.find(entry => entry.root === source.root && entry.path === source.path);
      if (entry?.kind !== 'file' || entry.decoding.kind !== 'decoded' ||
        acquired.decoding.identity.sha256 !== entry.decoding.identity.sha256 ||
        acquired.decoding.identity.byteCount !== entry.decoding.identity.byteCount) throw new WorkspaceFailure('pipelineChanged', source);
      return { ...acquired, text: acquired.decoding.text };
    });
  }
  readGit(request: GitRequest, encode?: ResultEncoding) {
    const captured = structuredClone(request);
    return this.#track(() => readGit(this, captured, encode));
  }
  prepareGitRead(input: Extract<NativeOperation, { kind: 'prepareGitRead' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  projectGitRead(input: Extract<NativeOperation, { kind: 'projectGitRead' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      await access.bridge.request({ kind: 'openRoots', roots: this.snapshot.roots.map(root => ({ name: root.name,
        absolutePath: root.identity.declaredPath, access: 'source', expected: root.identity })) }, this.signal);
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  prepareGitShow(input: Extract<NativeOperation, { kind: 'prepareGitShow' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  parseGitShowMetadata(input: Extract<NativeOperation, { kind: 'parseGitShowMetadata' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  projectGitShow(input: Extract<NativeOperation, { kind: 'projectGitShow' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      await access.bridge.request({ kind: 'openRoots', roots: this.snapshot.roots.map(root => ({ name: root.name,
        absolutePath: root.identity.declaredPath, access: 'source', expected: root.identity })) }, this.signal);
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  readFile(request: ReadRequest, encode?: ResultEncoding) {
    const captured = structuredClone(request);
    return this.#track(() => readFile(this, captured, encode));
  }
  fileSearch(request: SearchRequest, encode?: ResultEncoding) {
    const captured = structuredClone(request);
    return this.#track(() => fileSearch(this, captured, encode));
  }
  getFileTree(request: TreeRequest, encode?: ResultEncoding) {
    const captured = structuredClone(request);
    return this.#track(() => getFileTree(this, captured, encode));
  }
  renderFileTree(input: Extract<NativeOperation, { kind: 'renderFileTree' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  getCodeStructure(request: StructureRequest, encode?: ResultEncoding) {
    const captured = structuredClone(request);
    return this.#track(() => getCodeStructure(this, captured, encode));
  }
  sliceReadText(input: Extract<NativeOperation, { kind: 'sliceReadText' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  calculateSliceRanges(input: Extract<NativeOperation, { kind: 'calculateSliceRanges' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  queryStructure(input: Extract<NativeOperation, { kind: 'queryStructure' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  cancel(): void { this.#controller.abort(); }
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.cancel();
      try { await this.#bridge?.close(); }
      finally { await Promise.allSettled([...this.#pending]); await this.release(); }
    })();
    return this.#closing;
  }
}
