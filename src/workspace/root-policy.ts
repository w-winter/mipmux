import { posix } from 'node:path';
import type { Static } from 'typebox';
import type { WorkspaceSpec, PolicyInput, PolicySnapshot, SourcePath, AdmittedRoot, IgnoreSettings } from '../contracts/inventory.js';
import type { NativeIgnoreInputs } from '../contracts/native.js';
import type { RootIdentity } from '../contracts/workspace.js';
import { NativeAccess } from './source-access.js';
import { canonicalJSON, compareBytes, freeze, sha256, WorkspaceFailure } from './values.js';

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
function inputKey(input: PolicyInput): string { return canonicalJSON([input.root, input.path]); }

/** Captures controlling files and applies the original ordinary-crawl policy at the native boundary. */
export class RootPolicy {
  readonly #inputs = new Map<string, PolicyInput>();
  readonly #roots = new Map<string, CapturedIgnoreInputs>();
  readonly #directories = new Map<string, CapturedIgnoreInputs>();
  constructor(readonly declaration: PolicyDeclaration, readonly access: NativeAccess) {}

  #absolute(source: SourcePath): string { return posix.join(this.access.root(source.root).identity.canonicalPath, source.path); }
  #bindings(source: SourcePath): SourcePath[] {
    const absolute = this.#absolute(source);
    return this.declaration.roots.filter(root => contains(root.identity.canonicalPath, absolute))
      .map(root => ({ root: root.name, path: relative(root.identity.canonicalPath, absolute) }));
  }
  denied(source: SourcePath): boolean {
    const absolute = this.#absolute(source);
    if (absolute.split('/').some(part => part === '.git' || part === '.env' || part.startsWith('.env.'))) return true;
    const aliases = this.declaration.roots.filter(root => contains(root.identity.canonicalPath, absolute))
      .map(root => posix.resolve(root.identity.declaredPath, relative(root.identity.canonicalPath, absolute)));
    if (this.declaration.deniedAbsolutePaths.some(path => contains(path, absolute) || aliases.some(alias => contains(path, alias)))) return true;
    for (const binding of this.#bindings(source)) {
      for (const rule of this.declaration.exclusions) {
        if (rule.root !== binding.root) continue;
        const prefixes = binding.path.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
        if (rule.kind === 'prefix' ? contains(rule.path, binding.path) : prefixes.some(path => posix.matchesGlob(path, rule.pattern))) return true;
      }
    }
    return false;
  }


  async #capture(root: string, directory: string): Promise<CapturedIgnoreInputs> {
    const key = canonicalJSON([root, directory]);
    const cached = directory ? this.#directories.get(key) : this.#roots.get(root);
    if (cached) return cached;
    const reply = await this.access.bridge.request({
      kind: 'captureIgnoreInputs', root: this.access.root(root).handle,
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

  async admitted(source: SourcePath, directory: boolean): Promise<boolean> {
    if (this.denied(source)) return false;
    for (const binding of this.#bindings(source)) {
      const rootInputs = await this.#capture(binding.root, '');
      const directories: { path: string; controls: CapturedIgnoreInputs['controls'] }[] = [];
      if (rootInputs.settings.enableHierarchicalIgnores) for (const ancestor of ancestors(binding.path)) {
        if (!ancestor) continue;
        const captured = this.#directories.get(canonicalJSON([binding.root, ancestor]));
        if (captured) directories.push({ path: ancestor, controls: captured.controls });
      }
      const result = await this.access.bridge.request({ kind: 'queryIgnoreHierarchy', rootInputs, directories,
        capture: { kind: 'captureIgnoreInputs', root: this.access.root(binding.root).handle, directory: { kind: 'root' },
          settings: rootInputs.settings, deniedAbsolutePaths: [...this.declaration.deniedAbsolutePaths] },
        queries: [{ path: binding.path, isDirectory: directory }] }, this.access.signal);
      for (const captured of result.result.directories) {
        const value = { ...rootInputs, controls: captured.controls };
        this.#directories.set(canonicalJSON([binding.root, captured.path]), value);
        for (const control of captured.controls) {
          const input = { root: binding.root, ...control };
          this.#inputs.set(inputKey(input), input);
        }
      }
      const verdict = result.result.paths[0]!;
      if (verdict.isDirectory ? !verdict.directoryIncluded : verdict.ignored) return false;
    }
    return true;
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

  async revalidate(source: SourcePath, snapshot: PolicySnapshot): Promise<void> {
    for (const binding of this.#bindings(source)) {
      const root = await this.#capture(binding.root, '');
      const previousRoot = snapshot.roots.find(root => root.root === binding.root);
      if (!previousRoot || canonicalJSON({ root: binding.root, authority: root.authority, settings: root.settings }) !== canonicalJSON(previousRoot)) {
        throw new WorkspaceFailure('policyChanged', source);
      }
      const relevant = [...root.controls];
      if (root.settings.enableHierarchicalIgnores) for (const ancestor of ancestors(binding.path)) {
        if (ancestor) relevant.push(...(await this.#capture(binding.root, ancestor)).controls);
      }
      for (const control of relevant) {
        const previous = snapshot.inputs.find(input => input.root === binding.root && input.path === control.path);
        if (!previous || canonicalJSON({ root: binding.root, ...control }) !== canonicalJSON(previous)) {
          throw new WorkspaceFailure('policyChanged', source);
        }
      }
    }
    if (!await this.admitted(source, false)) throw new WorkspaceFailure('policyChanged', source);
  }
}
