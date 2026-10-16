import type { InventorySnapshot, SourcePath, PolicySnapshot } from '../contracts/inventory.js';
import type { ReadRequest, TreeRequest, StructureRequest, SearchRequest } from '../contracts/exploration.js';
import type { BridgeClient } from '../native/bridge-client.js';
import type { SmipRuntime } from '../runtime/smip-runtime.js';
import { NativeAccess } from './source-access.js';
import { RootPolicy, deniedAbsolutePath, type PolicyDeclaration } from './root-policy.js';
import { canonicalJSON, WorkspaceFailure } from './values.js';
import { readFile } from '../exploration/read.js';
import { getFileTree } from '../exploration/tree.js';
import { getCodeStructure } from '../exploration/structure.js';
import { readGit } from '../exploration/git.js';
import { captureGitDiff } from '../exploration/git-diff.js';
import type { GitRequest } from '../contracts/git.js';
import { fileSearch } from '../exploration/search.js';
import type { ResultEncoding } from '../exploration/output-budget.js';
import type { NativeOperation, NativeHandle } from '../contracts/native.js';
import type { RootIdentity } from '../contracts/workspace.js';
import type { WorkspaceRuntime } from './workspace-runtime.js';
import { capturedFile, completeFile } from './inventory-file.js';
import { observe } from './observe.js';
import type { CatalogedGitArtifact } from './git-artifact-catalog.js';
import { join } from 'node:path';

/** Pins one inventory and owns a separate bridge until close joins admitted operations. */
export class WorkspaceOperation {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  #access: Promise<NativeAccess> | null = null;
  #bridge: BridgeClient | null = null;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #codemapRetains = new Set<() => Promise<void>>();
  readonly #codemapPresentations = new Set<() => void>();
  #closing: Promise<void> | null = null;
  constructor(private readonly baseSnapshot: InventorySnapshot, readonly declaration: PolicyDeclaration,
    signal: AbortSignal,
    readonly runtime: SmipRuntime, readonly release: () => Promise<void>, private readonly openPinned: (signal: AbortSignal) => Promise<WorkspaceOperation>,
    private readonly catalog: { kind: 'workspace'; owner: WorkspaceRuntime } | { kind: 'verification' }) { this.signal = AbortSignal.any([signal, this.#controller.signal]); }
  get snapshot(): InventorySnapshot {
    return this.catalog.kind === 'workspace' ? this.catalog.owner.registeredSnapshot(this.baseSnapshot) : this.baseSnapshot;
  }
  registerGitArtifact(entry: CatalogedGitArtifact): void {
    this.#check();
    if (this.catalog.kind !== 'workspace') throw new WorkspaceFailure('verificationOperationOnly');
    this.catalog.owner.registerGitArtifact(entry);
  }
  catalogedGitArtifact(path: string): CatalogedGitArtifact | null {
    this.#check();
    if (this.catalog.kind !== 'workspace') throw new WorkspaceFailure('verificationOperationOnly');
    return this.catalog.owner.catalogedGitArtifact(path);
  }
  readGitSnapshotFile(entry: Pick<CatalogedGitArtifact, 'checkout' | 'snapshotID' | 'path'>) {
    const captured = structuredClone(entry);
    return this.#track(() => {
      const root = this.snapshot.outputRoot, denied = [...this.declaration.deniedAbsolutePaths];
      const implicitOutputDeny = denied.indexOf(root.canonicalPath);
      if (implicitOutputDeny < 0) throw new WorkspaceFailure('invalidOutputPolicy');
      // Output capability waives only the implicit source-read deny; explicit credential duplicates remain denied.
      denied.splice(implicitOutputDeny, 1);
      const path = join(root.canonicalPath, '_git_data/repos', captured.checkout.repoKey, captured.snapshotID, captured.path);
      if (deniedAbsolutePath({ ...this.declaration, deniedAbsolutePaths: denied }, path, path)) throw new WorkspaceFailure('pathDenied');
      return this.runtime.mutateGitSnapshots(root, this.signal, async (signal, access) =>
        (await access.bridge.request({ kind: 'readGitSnapshotFile', root: access.root,
          repoKey: captured.checkout.repoKey, snapshotID: captured.snapshotID, path: captured.path }, signal)).result);
    });
  }
  registerExplicitSource(source: SourcePath) {
    const captured = structuredClone(source);
    return this.#track(async () => {
      if (this.catalog.kind !== 'workspace') throw new WorkspaceFailure('verificationOperationOnly');
      const existing = this.snapshot.entries.find(entry => entry.root === captured.root && entry.path === captured.path);
      if (existing?.kind === 'file') return existing;
      const access = await (this.#access ??= this.#openAccess());
      const policy = new RootPolicy(this.declaration, access);
      if (policy.denied(captured)) throw new WorkspaceFailure('pathDenied', captured);
      const visibility = await policy.admitted(captured, false) ? 'discoverable' : 'managedOnly';
      const acquired = await access.read(captured, null);
      this.signal.throwIfAborted();
      const entry = capturedFile(captured, acquired, visibility);
      const owner = this.catalog.owner;
      owner.registerExplicitFile(this.snapshot, entry, policy.snapshot());
      return entry;
    });
  }
  requestExplicitCodemap(source: SourcePath) {
    const captured = structuredClone(source);
    return this.#track(async () => {
      if (this.catalog.kind !== 'workspace') throw new WorkspaceFailure('verificationOperationOnly');
      const entry = await this.registerExplicitSource(captured);
      this.signal.throwIfAborted();
      if (entry.structural.kind !== 'pending') return { result: Promise.resolve(entry), release: async () => {} };
      const owner = this.catalog.owner;
      const lease = owner.retainCodemap(entry, async signal => {
        const operation = await this.openPinned(signal);
        try {
          const access = await (operation.#access ??= operation.#openAccess());
          const acquired = await operation.readRawSource(captured);
          const complete = await completeFile(access, entry, acquired, this.runtime.artifacts, () => owner.retain(), owner.artifactBuildSignal);
          const current = await operation.readRawSource(captured);
          if (canonicalJSON([current.identity, current.key, current.fingerprint.mode]) !==
            canonicalJSON([acquired.identity, acquired.key, acquired.fingerprint.mode])) throw new WorkspaceFailure('sourceChanged', captured);
          signal.throwIfAborted();
          owner.completeExplicitFile(complete);
          return complete;
        } finally { await operation.close(); }
      });
      const release = async () => { await lease.release(); this.#codemapRetains.delete(release); };
      this.#codemapRetains.add(release);
      return { result: lease.result, release };
    });
  }
  retainCodemapPresentation(root: string): (() => void) | null {
    this.#check();
    if (this.catalog.kind !== 'workspace') throw new WorkspaceFailure('verificationOperationOnly');
    const retained = this.catalog.owner.retainCodemapPresentation(root);
    if (retained === null) return null;
    const release = () => { retained(); this.#codemapPresentations.delete(release); };
    this.#codemapPresentations.add(release);
    return release;
  }
  materializeExplicitSource(source: SourcePath) {
    return this.#track(async () => {
      const demand = await this.requestExplicitCodemap(source);
      try { await observe(demand.result, this.signal); }
      finally { await demand.release(); }
    });
  }
  fork(signal: AbortSignal): Promise<WorkspaceOperation> { this.#check(); return this.openPinned(signal); }
  validateSourceRoot(name: string) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      await access.validateRoot(name);
    });
  }
  validateSourceRoots() {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      await access.bridge.request({ kind: 'openRoots', roots: this.snapshot.roots.map(root => ({ name: root.name,
        absolutePath: root.identity.declaredPath, access: 'source', expected: root.identity })) }, this.signal);
    });
  }
  validateRoots() {
    return this.#track(async () => {
      await this.validateSourceRoots();
      const access = await (this.#access ??= this.#openAccess());
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
    return new NativeAccess(bridge, this.snapshot.roots, this.signal);
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
      await policy.revalidate(source, this.snapshot.policy, entry.visibility);
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
      return { ...acquired, decoding: acquired.decoding, text: acquired.decoding.text };
    });
  }
  readGit(request: GitRequest, encode?: ResultEncoding) {
    const captured = structuredClone(request);
    return this.#track(() => readGit(this, captured, encode));
  }
  /** Captures authorized evidence before reply projection; maxOutputBytes does not limit this internal acquisition. */
  captureGitDiff(request: Extract<GitRequest, { op: 'diff' }>, generateDiffText: boolean) {
    const captured = structuredClone(request);
    return this.#track(() => captureGitDiff(this, captured, generateDiffText));
  }
  electGitTarget(paths: readonly string[]) {
    const captured = [...paths];
    return this.#track(async () => {
      await this.validateSourceRoots();
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request({ kind: 'electGitTarget', paths: captured,
        roots: this.snapshot.roots.map(root => ({ name: root.name, path: root.identity.canonicalPath })) }, this.signal)).result;
    });
  }
  resolveAutomaticReviewGit(paths: readonly string[], base: string | null) {
    const captured = [...paths];
    return this.#track(async () => {
      await this.validateRoots();
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request({ kind: 'resolveAutomaticReviewGit', paths: captured, base,
        roots: this.snapshot.roots.map(root => ({ name: root.name, path: root.identity.canonicalPath })) }, this.signal)).result;
    });
  }
  revalidateGitTargets(input: Extract<NativeOperation, { kind: 'revalidateGitTargets' }>) {
    const captured = structuredClone(input);
    return this.#track(async () => {
      await this.validateSourceRoots();
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(captured, this.signal)).result;
    });
  }
  openGitSourceAccess(identity: RootIdentity) {
    const captured = structuredClone(identity);
    return this.#track(async () => {
      await this.validateSourceRoots();
      const access = await (this.#access ??= this.#openAccess());
      const opened = await access.bridge.request({ kind: 'openRoots', roots: [{ name: 'GitRepository',
        absolutePath: captured.declaredPath, access: 'source', expected: captured }] }, this.signal);
      return new NativeAccess(access.bridge, opened.result.roots, this.signal);
    });
  }
  resolveGitSnapshotComparison(repository: NativeHandle, compare: string) {
    const captured = structuredClone(repository);
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess()), root = this.snapshot.outputRoot;
      const opened = await access.bridge.request({ kind: 'openRoots', roots: [{ name: 'GitSnapshots', absolutePath: root.declaredPath,
        access: 'output', expected: root }] }, this.signal);
      const output = opened.result.roots[0];
      if (!output) throw new WorkspaceFailure('nativeProtocolError');
      return (await access.bridge.request({ kind: 'resolveGitSnapshotComparison', output: output.handle,
        repository: captured, compare }, this.signal)).result;
    });
  }
  gitDiffOperation<O extends Extract<NativeOperation, { kind: 'prepareGitDiff' | 'normalizeGitSelectedPaths' | 'parseGitDiffStats' | 'normalizeGitUntrackedPatch' | 'parseGitPatch' | 'projectGitDiff' | 'prepareGitWorktreeMainRoot' | 'resolveGitWorktreeConfig' | 'projectGitWorktreeListing' | 'renderGitWorktreeReply' | 'planGitPublication' | 'prepareGitPublicationMetadata' | 'normalizeGitPublicationOptions' | 'decorateGitArtifacts' | 'authorizeGitArtifact' }>>(input: O) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
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
      await this.validateSourceRoots();
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
  askUser<O extends Extract<NativeOperation, { kind: 'prepareAskUser' | 'answerAskUser' }>>(input: O) {
    const captured = structuredClone(input);
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(captured, this.signal)).result;
    });
  }
  calculateSliceRanges(input: Extract<NativeOperation, { kind: 'calculateSliceRanges' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  parseSelectionInputs(input: Extract<NativeOperation, { kind: 'parseSelectionInputs' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  selectionPathBindings(paths: readonly string[]) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request({ kind: 'selectionPathBindings', paths: [...paths] }, this.signal)).result.paths;
    });
  }
  prepareSelection(input: Extract<NativeOperation, { kind: 'prepareSelection' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  transitionSelection(input: Extract<NativeOperation, { kind: 'transitionSelection' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  selectionHint(paths: readonly string[], operation: string) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request({ kind: 'selectionHint', paths: [...paths], operation,
        roots: this.snapshot.roots.map(root => ({ name: root.name, path: root.identity.canonicalPath })) }, this.signal)).result.message;
    });
  }
  renderSelectionReply(input: Extract<NativeOperation, { kind: 'renderSelectionReply' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result.reply;
    });
  }
  prepareSearchPattern(input: Extract<NativeOperation, { kind: 'prepareSearchPattern' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  matchSearchPaths(input: Extract<NativeOperation, { kind: 'matchSearchPaths' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  scanLiteralLines(input: Extract<NativeOperation, { kind: 'scanLiteralLines' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  scanRegexContent(input: Extract<NativeOperation, { kind: 'scanRegexContent' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  compileRegexContent(input: Extract<NativeOperation, { kind: 'compileRegexContent' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  prepareSearchRecovery(input: Extract<NativeOperation, { kind: 'prepareSearchRecovery' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  renderFileBlock(input: Extract<NativeOperation, { kind: 'renderFileBlock' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  mutateSelectionPaths(input: Extract<NativeOperation, { kind: 'mutateSelectionPaths' }>) {
    return this.#track(async () => {
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  queryStructure(input: Extract<NativeOperation, { kind: 'queryStructure' }>) {
    return this.#track(async () => {
      await this.validateSourceRoots();
      const access = await (this.#access ??= this.#openAccess());
      return (await access.bridge.request(input, this.signal)).result;
    });
  }
  cancel(): void { this.#controller.abort(); }
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.cancel();
      for (const release of this.#codemapPresentations) release();
      try { await Promise.all([...this.#codemapRetains].map(release => release())); await this.#bridge?.close(); }
      finally { await Promise.allSettled([...this.#pending]); await this.release(); }
    })();
    return this.#closing;
  }
}
