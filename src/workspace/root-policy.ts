import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Static } from 'typebox';
import type { WorkspaceSpec, PolicyInput, PolicySnapshot, SourcePath, AdmittedRoot, IgnoreSettings } from '../contracts/inventory.js';
import type { NativeFrame, NativeHandle, NativeIgnoreInputs, NativeResult } from '../contracts/native.js';
import type { RootIdentity } from '../contracts/workspace.js';
import { NativeAccess } from './source-access.js';
import { canonicalJSON, compareBytes, freeze, sha256, WorkspaceFailure } from './values.js';
import { gitExcluded, type GitExclusionSource } from './git-exclusions.js';

export interface PolicyDeclaration {
  readonly roots: readonly AdmittedRoot[];
  readonly outputRoot: RootIdentity;
  readonly exclusions: WorkspaceSpec['exclusions'];
  readonly deniedAbsolutePaths: readonly string[];
  readonly ignoreSettings: IgnoreSettings | null;
}
export function contains(parent: string, path: string): boolean { return path === parent || path.startsWith(parent === '/' ? '/' : parent + '/'); }
function relative(root: string, path: string): string { return root === '/' ? path.slice(1) : path.slice(root.length + 1); }
function ancestors(path: string): string[] {
  const parts = path.split('/'); parts.pop();
  return ['', ...parts.map((_, index) => parts.slice(0, index + 1).join('/'))];
}
type CapturedIgnoreInputs = Static<typeof NativeIgnoreInputs>;
type CapturedDirectories = Extract<NativeResult, { kind: 'ignoreHierarchy' }>['directories'];
type Verdict = Extract<NativeResult, { kind: 'ignoreHierarchy' }>['paths'][number];
type ListedEntry = Extract<NativeFrame, { kind: 'entry' }>;
/** Admission for a known root binding of each source, by root-relative path. */
interface KnownVerdicts { readonly root: string; readonly verdicts: ReadonlyMap<string, boolean> }
function inputKey(input: PolicyInput): string { return canonicalJSON([input.root, input.path]); }
function admittedVerdict(verdict: Verdict): boolean { return !(verdict.isDirectory ? !verdict.directoryIncluded : verdict.ignored); }

/** Applies host denies to physical evidence and its logical loaded-root path. */
export function deniedAbsolutePath(declaration: PolicyDeclaration, absolute: string, logicalPath: string): boolean {
  if ([absolute, logicalPath].some(path => path.split('/').some(part => part === '.git' || part === '.env' || part.startsWith('.env.')))) return true;
  const bindings = declaration.roots.filter(root => contains(root.identity.canonicalPath, logicalPath))
    .map(root => ({ root, path: relative(root.identity.canonicalPath, logicalPath) }));
  const aliases = bindings.map(binding => posix.resolve(binding.root.identity.declaredPath, binding.path));
  if (declaration.deniedAbsolutePaths.some(path => contains(path, absolute) || contains(path, logicalPath) || aliases.some(alias => contains(path, alias)))) return true;
  for (const binding of bindings) for (const rule of declaration.exclusions) {
    if (rule.root !== binding.root.name) continue;
    const prefixes = binding.path.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
    if (rule.kind === 'prefix' ? contains(rule.path, binding.path) : prefixes.some(path => posix.matchesGlob(path, rule.pattern))) return true;
  }
  return false;
}

function knownVerdict(known: KnownVerdicts, path: string): boolean {
  const verdict = known.verdicts.get(path);
  if (verdict === undefined) throw new WorkspaceFailure('nativeProtocolError');
  return verdict;
}

/** Groups by root the `rank`th binding of each source still admitted, with the source's index. */
function bindingRound(sources: readonly { directory: boolean }[], bindings: readonly (readonly SourcePath[] | null)[],
  verdicts: readonly boolean[], rank: number): Map<string, { index: number; path: string; isDirectory: boolean }[]> {
  const round = new Map<string, { index: number; path: string; isDirectory: boolean }[]>();
  for (const [index, { directory }] of sources.entries()) {
    const binding = verdicts[index] ? bindings[index]?.[rank] : undefined;
    if (!binding) continue;
    const bound = round.get(binding.root) ?? [];
    bound.push({ index, path: binding.path, isDirectory: directory }); round.set(binding.root, bound);
  }
  return round;
}

/**
 * Captures controlling files and applies the original ordinary-crawl policy at the native boundary. A path it admits is also
 * withheld when `git` lists it as an untracked path that Git ignores in any root containing it.
 */
export class RootPolicy {
  readonly #inputs = new Map<string, PolicyInput>();
  readonly #roots = new Map<string, CapturedIgnoreInputs>();
  readonly #directories = new Map<string, CapturedIgnoreInputs>();
  #walk: string | null = null;
  constructor(readonly declaration: PolicyDeclaration, readonly access: NativeAccess, readonly git: GitExclusionSource) {}

  #absolute(source: SourcePath): string { return posix.join(this.access.root(source.root).identity.canonicalPath, source.path); }
  #bindings(source: SourcePath): SourcePath[] {
    const absolute = this.#absolute(source);
    return this.declaration.roots.filter(root => contains(root.identity.canonicalPath, absolute))
      .map(root => ({ root: root.name, path: relative(root.identity.canonicalPath, absolute) }));
  }
  denied(source: SourcePath): boolean {
    const absolute = this.#absolute(source);
    return deniedAbsolutePath(this.declaration, absolute, absolute);
  }


  async #capture(root: string, directory: string): Promise<CapturedIgnoreInputs> {
    const key = canonicalJSON([root, directory]);
    const cached = directory ? this.#directories.get(key) : this.#roots.get(root);
    if (cached) return cached;
    const reply = await this.access.bridge.request({
      kind: 'captureIgnoreInputs', root: (await this.access.openRoot(root)).handle,
      directory: directory ? { kind: 'descendant', path: directory } : { kind: 'root' },
      settings: this.declaration.ignoreSettings, deniedAbsolutePaths: [...this.declaration.deniedAbsolutePaths],
    }, this.access.signal);
    const captured = freeze(structuredClone(reply.result));
    if (directory) {
      const base = await this.#capture(root, '');
      if (canonicalJSON(captured.authority) !== canonicalJSON(base.authority)) throw new WorkspaceFailure('policyChanged', { root });
      this.#directories.set(key, captured);
    } else this.#roots.set(root, captured);
    for (const control of captured.controls) {
      const input = { root, ...control };
      this.#inputs.set(inputKey(input), input);
    }
    return captured;
  }

  /** The captured controls of the paths' ancestor directories, parents first, for reuse by a hierarchy query. */
  #capturedAncestors(root: string, paths: readonly string[]): { path: string; controls: CapturedIgnoreInputs['controls'] }[] {
    // Captured directories are ancestor-closed and each path's ancestors run shallow first, so parents precede children.
    const directories = new Map<string, CapturedIgnoreInputs['controls']>();
    for (const path of paths) for (const ancestor of ancestors(path)) {
      const captured = ancestor && !directories.has(ancestor) ? this.#directories.get(canonicalJSON([root, ancestor])) : undefined;
      if (captured) directories.set(ancestor, captured.controls);
    }
    return [...directories].map(([path, controls]) => ({ path, controls }));
  }

  /** The request that captures a root's ignore inputs, which native code repeats for the directories it captures. */
  #captureRequest(handle: NativeHandle, rootInputs: CapturedIgnoreInputs) {
    return { kind: 'captureIgnoreInputs' as const, root: handle, directory: { kind: 'root' as const },
      settings: rootInputs.settings, deniedAbsolutePaths: [...this.declaration.deniedAbsolutePaths] };
  }

  /** Records the directories that native code captured while evaluating paths under `root`. */
  #record(root: string, rootInputs: CapturedIgnoreInputs, directories: CapturedDirectories): void {
    for (const captured of directories) {
      const value = { ...rootInputs, controls: captured.controls };
      this.#directories.set(canonicalJSON([root, captured.path]), value);
      for (const control of captured.controls) {
        const input = { root, ...control };
        this.#inputs.set(inputKey(input), input);
      }
    }
  }

  /** Evaluates root-relative paths under one root with a single hierarchy query; returns whether each path is admitted. */
  async #query(root: string, queries: readonly { path: string; isDirectory: boolean }[]): Promise<boolean[]> {
    const rootInputs = await this.#capture(root, '');
    const result = await this.access.bridge.request({ kind: 'queryIgnoreHierarchy', rootInputs,
      directories: rootInputs.settings.enableHierarchicalIgnores ? this.#capturedAncestors(root, queries.map(query => query.path)) : [],
      capture: this.#captureRequest((await this.access.openRoot(root)).handle, rootInputs),
      queries: [...queries] }, this.access.signal);
    this.#record(root, rootInputs, result.result.directories);
    if (result.result.paths.length !== queries.length) throw new WorkspaceFailure('nativeProtocolError');
    return result.result.paths.map(admittedVerdict);
  }

  /**
   * Lists one directory of an inventory walk and decides admission for its regular files and directories, as `directory`,
   * a listing and `admittedAll` would together, in one native request. The helper keeps the walk's compiled rules between
   * requests, so a policy walks one inventory, on one bridge, listing each root before its descendants and each directory
   * before its children.
   */
  async walkDirectory(root: string, path: string): Promise<{ children: { child: ListedEntry; source: SourcePath }[];
    admitted: ReadonlySet<ListedEntry> }> {
    const rootInputs = await this.#capture(root, '');
    const handle = (await this.access.openRoot(root)).handle, walk = this.#walk ??= randomUUID();
    const reply = await this.access.bridge.request(path
      ? { kind: 'walkDirectory', walk, root: handle, directory: { kind: 'descendant', path } }
      : { kind: 'walkDirectory', walk, root: handle, directory: { kind: 'root' }, rootInputs, capture: this.#captureRequest(handle, rootInputs) },
    this.access.signal);
    this.#record(root, rootInputs, reply.result.directories);
    const { verdicts } = reply.result;
    if (verdicts.length !== reply.entries.length) throw new WorkspaceFailure('nativeProtocolError');
    const known = new Map<string, boolean>();
    const children = reply.entries.map((child, index) => {
      const source = { root, path: path ? path + '/' + child.name : child.name }, verdict = verdicts[index] ?? null;
      const evaluated = child.entryKind === 'file' || child.entryKind === 'directory';
      if (evaluated !== (verdict !== null) || verdict && (verdict.path !== source.path || verdict.isDirectory !== (child.entryKind === 'directory'))) {
        throw new WorkspaceFailure('nativeProtocolError');
      }
      if (verdict) known.set(source.path, admittedVerdict(verdict));
      return { child, source };
    });
    const candidates = children.filter(({ child, source }) => !this.denied(source) && (child.entryKind === 'file' || child.entryKind === 'directory'));
    const included = await this.#admit(candidates.map(({ child, source }) => ({ source, directory: child.entryKind === 'directory' })),
      { root, verdicts: known });
    return { children, admitted: new Set(candidates.filter((_, index) => included[index]).map(({ child }) => child)) };
  }

  async admitted(source: SourcePath, directory: boolean): Promise<boolean> {
    const [admitted] = await this.admittedAll([{ source, directory }]);
    return admitted === true;
  }

  /**
   * Returns whether each source is admitted. A source's binding roots are queried in declaration order and stop at the first
   * exclusion, so the captured controls match querying each source alone; each round sends one query per root.
   */
  admittedAll(sources: readonly { source: SourcePath; directory: boolean }[]): Promise<boolean[]> { return this.#admit(sources, null); }

  /** `admittedAll`, taking the bindings under `known.root` from `known` instead of querying them. */
  async #admit(sources: readonly { source: SourcePath; directory: boolean }[], known: KnownVerdicts | null): Promise<boolean[]> {
    const bindings = sources.map(({ source }) => this.denied(source) ? null : this.#bindings(source));
    const verdicts = bindings.map(bound => bound !== null);
    for (let rank = 0; ; rank++) {
      const round = bindingRound(sources, bindings, verdicts, rank);
      if (!round.size) break;
      for (const [root, bound] of round) {
        const included = root === known?.root ? bound.map(({ path }) => knownVerdict(known, path))
          : await this.#query(root, bound.map(({ path, isDirectory }) => ({ path, isDirectory })));
        for (const [position, { index }] of bound.entries()) if (!included[position]) verdicts[index] = false;
      }
    }
    for (const [index, bound] of bindings.entries()) if (verdicts[index] && bound && await this.#gitIgnored(bound)) verdicts[index] = false;
    return verdicts;
  }

  /** Whether Git ignores the path as untracked in any of its binding roots. */
  async #gitIgnored(bindings: readonly SourcePath[]): Promise<boolean> {
    for (const { root, path } of bindings) {
      const { authority } = await this.#capture(root, '');
      if (gitExcluded(await this.git.paths(root, authority, this.access.root(root).identity.canonicalPath), path)) return true;
    }
    return false;
  }

  async directory(root: string, directory: string): Promise<void> {
    const base = await this.#capture(root, '');
    if (directory && base.settings.enableHierarchicalIgnores) await this.#capture(root, directory);
  }

  snapshot(): PolicySnapshot {
    const roots = [...this.#roots.entries()].sort(([a], [b]) => compareBytes(a, b))
      .map(([root, value]) => ({ root, authority: value.authority, settings: value.settings }));
    const inputs = [...this.#inputs.values()].sort((a, b) => compareBytes(inputKey(a), inputKey(b)));
    const body = { implementation: 'rpce-ignore-v1' as const, roots, inputs };
    return freeze({ ...body, digest: sha256(canonicalJSON(body)) });
  }

  async revalidate(source: SourcePath, snapshot: PolicySnapshot, visibility: 'discoverable' | 'managedOnly' = 'discoverable'): Promise<void> {
    const admitted = await this.admitted(source, false);
    if (!admitted && visibility === 'discoverable' || this.denied(source)) throw new WorkspaceFailure('policyChanged', source);
    this.#matchSnapshot(this.#bindings(source).map(binding => ({ root: binding.root, source })), snapshot);
  }

  /** Revalidates discoverable sources as `revalidate` does, querying each root binding once for all of them. */
  async revalidateAll(sources: readonly SourcePath[], snapshot: PolicySnapshot): Promise<void> {
    const byRoot = new Map<string, { source: SourcePath; path: string }[]>();
    for (const source of sources) {
      if (this.denied(source)) throw new WorkspaceFailure('policyChanged', source);
      for (const binding of this.#bindings(source)) {
        const bound = byRoot.get(binding.root) ?? [];
        bound.push({ source, path: binding.path }); byRoot.set(binding.root, bound);
      }
    }
    for (const [root, bound] of byRoot) {
      const included = await this.#query(root, bound.map(({ path }) => ({ path, isDirectory: false })));
      const excluded = bound.find((_, index) => !included[index]);
      if (excluded) throw new WorkspaceFailure('policyChanged', excluded.source);
    }
    for (const source of sources) if (await this.#gitIgnored(this.#bindings(source))) throw new WorkspaceFailure('policyChanged', source);
    this.#matchSnapshot([...byRoot].map(([root, bound]) => ({ root, source: bound[0]!.source })), snapshot);
  }

  /** Requires each binding root's captured policy and controlling inputs to equal the snapshot's. */
  #matchSnapshot(bindings: readonly { root: string; source: SourcePath }[], snapshot: PolicySnapshot): void {
    const captured = this.snapshot();
    for (const { root: name, source } of bindings) {
      const root = captured.roots.find(root => root.root === name);
      if (!root) continue;
      const previousRoot = snapshot.roots.find(root => root.root === name);
      if (!previousRoot || canonicalJSON(root) !== canonicalJSON(previousRoot)) {
        throw new WorkspaceFailure('policyChanged', source);
      }
      const relevant = captured.inputs.filter(input => input.root === name);
      for (const control of relevant) {
        const previous = snapshot.inputs.find(input => input.root === name && input.path === control.path);
        if (!previous || canonicalJSON(control) !== canonicalJSON(previous)) {
          throw new WorkspaceFailure('policyChanged', source);
        }
      }
    }
  }
}
