import { join } from 'node:path';
import type { NativeResult, NativeGitCheckout } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';
import type { Material } from './material-store.js';

type Resolution = Extract<NativeResult, { kind: 'gitTarget' }>;

/** Allows implicit Git reads only from the initially elected checkouts and revalidates all of them before each read. */
export class FrozenGitTarget {
  private constructor(private readonly resolution: Resolution) {}

  static async capture(operation: WorkspaceOperation, materials: ReadonlyMap<string, Material>): Promise<FrozenGitTarget> {
    const sources = [...materials.values()].flatMap(material => material.record.kind === 'source'
      && material.record.selection.kind !== 'codemap' ? [material.record.selection] : []);
    const paths = ['full', 'slices'].flatMap(kind => sources.filter(source => source.kind === kind).map(source => {
      const root = operation.snapshot.roots.find(root => root.name === source.source.root);
      if (!root) throw new WorkspaceFailure('unknownRoot');
      return join(root.identity.canonicalPath, source.source.path);
    }));
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
}
