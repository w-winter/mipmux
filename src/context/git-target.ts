import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { NativeResult, NativeGitCheckout } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { canonicalJSON, freeze, WorkspaceFailure } from '../workspace/values.js';
import type { Material } from './material-store.js';
import { resolveDiffRepository } from '../exploration/git-repository.js';

type Resolution = Extract<NativeResult, { kind: 'gitTarget' }>;

export function selectedGitSourcePaths(operation: WorkspaceOperation, materials: ReadonlyMap<string, Material>): string[] {
  const sources = [...materials.values()].flatMap(material => material.record.kind === 'source'
    && material.record.selection.kind !== 'codemap' ? [material.record.selection] : []);
  return ['full', 'slices'].flatMap(kind => sources.filter(source => source.kind === kind).map(source => {
    const root = operation.snapshot.roots.find(root => root.name === source.source.root);
    if (!root) throw new WorkspaceFailure('unknownRoot');
    return join(root.identity.canonicalPath, source.source.path);
  }));
}

/** Allows implicit Git reads only from the initially elected checkouts and revalidates all of them before each read. */
export class FrozenGitTarget {
  private constructor(private readonly resolution: Resolution) {}

  static async capture(operation: WorkspaceOperation, materials: ReadonlyMap<string, Material>): Promise<FrozenGitTarget> {
    const paths = selectedGitSourcePaths(operation, materials);
    const resolution: Resolution = !paths.length ? { kind: 'gitTarget', state: 'deferred' }
      : operation.runtime.options.git === undefined ? { kind: 'gitTarget', state: 'unavailable', reason: 'nonGitSelection', count: paths.length }
      : await operation.electGitTarget(paths);
    return new FrozenGitTarget(freeze(resolution));
  }

  async primary(operation: WorkspaceOperation): Promise<NativeGitCheckout> {
    if (this.resolution.state !== 'available') throw new WorkspaceFailure('gitTargetRequired');
    const current = await operation.revalidateGitTargets({ kind: 'revalidateGitTargets', checkouts: this.resolution.checkouts });
    if (!current.valid) throw new WorkspaceFailure('gitRepositoryChanged');
    return this.resolution.primary;
  }

  async publication(operation: WorkspaceOperation, materials: ReadonlyMap<string, Material>,
    selector: { readonly root: string | null; readonly worktree: string | null }): Promise<NativeGitCheckout> {
    const checkouts = await this.publicationRepositories(operation, materials, selector);
    if (this.resolution.state !== 'available') throw new WorkspaceFailure('gitTargetRequired');
    if (selector.root === null && selector.worktree === null) return this.resolution.primary;
    const checkout = checkouts[0];
    if (!checkout) throw new WorkspaceFailure('gitPublicationTargetDenied');
    return checkout;
  }

  async publicationRepositories(operation: WorkspaceOperation, materials: ReadonlyMap<string, Material>,
    selector: { readonly root: string | null; readonly worktree: string | null }): Promise<readonly NativeGitCheckout[]> {
    if (this.resolution.state !== 'available') throw new WorkspaceFailure('gitTargetRequired');
    await operation.validateRoots();
    await this.primary(operation);
    const current = (await FrozenGitTarget.capture(operation, materials)).resolution;
    if (current.state !== 'available') throw new WorkspaceFailure('gitSelectionOwnershipChanged');
    const identityKey = (checkout: NativeGitCheckout) => canonicalJSON([
      checkout.repoKey, checkout.repositoryID, checkout.worktreeID, checkout.checkoutRootPath,
    ]);
    const original = new Set(this.resolution.checkouts.map(identityKey));
    if (!current.checkouts.every(checkout => original.has(identityKey(checkout)))) {
      throw new WorkspaceFailure('gitSelectionOwnershipChanged');
    }
    const valid = await operation.revalidateGitTargets({ kind: 'revalidateGitTargets', checkouts: current.checkouts });
    if (!valid.valid) throw new WorkspaceFailure('gitRepositoryChanged');
    if (selector.root === null && selector.worktree === null) return this.resolution.checkouts;
    const requested = await resolveDiffRepository(operation, selector.root ?? this.resolution.primary.root,
      { kind: 'explicit', worktree: selector.worktree });
    const paths = await Promise.all(this.resolution.checkouts.map(checkout => realpath(checkout.checkoutRootPath)));
    const checkout = this.resolution.checkouts.find((_, index) => paths[index] === requested.repository.worktree.canonicalPath);
    if (!checkout) throw new WorkspaceFailure('gitPublicationTargetDenied');
    return [checkout];
  }
}
