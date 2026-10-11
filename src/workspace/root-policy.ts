import ignore from 'ignore';
import { posix } from 'node:path';
import type { WorkspaceSpec, PolicyInput, PolicySnapshot, SourcePath, AdmittedRoot } from '../contracts/inventory.js';
import type { RootIdentity } from '../contracts/workspace.js';
import { NativeFailure } from '../native/bridge-client.js';
import { NativeAccess } from './source-access.js';
import { canonicalJSON, compareBytes, freeze, sha256, WorkspaceFailure } from './values.js';

export interface PolicyDeclaration {
  readonly roots: readonly AdmittedRoot[];
  readonly outputRoot: RootIdentity;
  readonly exclusions: WorkspaceSpec['exclusions'];
  readonly deniedAbsolutePaths: readonly string[];
}
export function contains(parent: string, path: string): boolean { return path === parent || path.startsWith(parent === '/' ? '/' : parent + '/'); }
function decodeIgnoreControl(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (cause) {
    const failure = new WorkspaceFailure('decodeFailed');
    failure.cause = cause;
    throw failure;
  }
  if (text.includes('\0')) throw new WorkspaceFailure('binarySource');
  return text;
}

function relative(root: string, path: string): string { return root === '/' ? path.slice(1) : path.slice(root.length + 1); }
function policyPath(directory: string): string { return directory ? directory + '/.gitignore' : '.gitignore'; }
function ancestors(path: string): string[] {
  const parts = path.split('/'); parts.pop();
  return ['', ...parts.map((_, index) => parts.slice(0, index + 1).join('/'))];
}
function inputKey(input: SourcePath): string { return canonicalJSON(input); }

function scopedRules(text: string, directory: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (!directory) return lines;
  const scope = '/' + directory.replace(/[\\*?\[\] ]/g, '\\$&') + '/';
  return lines.map(raw => {
    const line = raw.replace(/^\uFEFF/, '');
    if (/^!? *$/.test(line) || line.startsWith('#')) return '';
    const negative = line.startsWith('!');
    const pattern = negative ? line.slice(1) : line;
    const anchored = pattern.startsWith('/') || pattern.replace(/ +$/, '').replace(/\/$/, '').includes('/');
    return (negative ? '!' : '') + scope + (anchored ? pattern.replace(/^\//, '') : '**/' + pattern);
  });
}

/** Keeps ignore control inputs separate from the paths they permit or exclude. */
export class RootPolicy {
  readonly #inputs = new Map<string, PolicyInput>();
  readonly #matchers = new Map<string, ReturnType<typeof ignore>>();
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

  async #load(source: SourcePath): Promise<PolicyInput> {
    const key = inputKey(source), cached = this.#inputs.get(key);
    if (cached) return cached;
    if (this.denied(source)) throw new WorkspaceFailure('policyInputDenied', source);
    let input: PolicyInput;
    try {
      const read = await this.access.read(source, null);
      const text = decodeIgnoreControl(read.bytes);
      input = { ...source, content: { kind: 'present', identity: read.identity, text } };
      const directory = source.path === '.gitignore' ? '' : posix.dirname(source.path);
      this.#matchers.set(key, ignore({ ignorecase: false }).add(scopedRules(text, directory)));
    } catch (error) {
      if (!(error instanceof NativeFailure && error.code === 'notFound')) throw error;
      input = { ...source, content: { kind: 'absent' } };
    }
    this.#inputs.set(key, input);
    return input;
  }

  async admitted(source: SourcePath, directory: boolean): Promise<boolean> {
    if (this.denied(source)) return false;
    for (const binding of this.#bindings(source)) {
      if (!binding.path) continue;
      const effective = ignore({ ignorecase: false });
      const parts = binding.path.split('/');
      for (const [index, ancestor] of ancestors(binding.path).entries()) {
        const control = { root: binding.root, path: policyPath(ancestor) };
        await this.#load(control);
        const matcher = this.#matchers.get(inputKey(control));
        if (matcher) effective.add(matcher);
        const prefix = parts.slice(0, index + 1).join('/');
        if (effective.ignores(prefix + (index < parts.length - 1 || directory ? '/' : ''))) return false;
      }
    }
    return true;
  }

  async directory(root: string, directory: string): Promise<void> {
    await this.#load({ root, path: policyPath(directory) });
  }

  snapshot(): PolicySnapshot {
    const inputs = [...this.#inputs.values()].sort((a, b) => compareBytes(inputKey(a), inputKey(b)));
    return freeze({ implementation: 'ignore-7.0.12-v1', inputs, digest: sha256(canonicalJSON(inputs)) });
  }

  async revalidate(source: SourcePath, snapshot: PolicySnapshot): Promise<void> {
    for (const binding of this.#bindings(source)) {
      for (const ancestor of ancestors(binding.path)) {
        const control = { root: binding.root, path: policyPath(ancestor) };
        const observed = await this.#load(control);
        const previous = snapshot.inputs.find(input => input.root === control.root && input.path === control.path);
        if (!previous || canonicalJSON(observed) !== canonicalJSON(previous)) throw new WorkspaceFailure('policyChanged', source);
      }
    }
    if (!await this.admitted(source, false)) throw new WorkspaceFailure('policyChanged', source);
  }
}
