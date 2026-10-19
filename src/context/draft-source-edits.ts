import type { SourceEdit, SourceSelection } from '../contracts/context.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { WorkspaceFailure, canonicalJSON } from '../workspace/values.js';
import { acquireSource, sourceId, type Material } from './material-store.js';
import { capturedState, selectionPath, type CanonicalSelection, type SelectionState } from './selection-preparation.js';

// Candidate membership and acquired materials stay together until the draft commits them.
class SourceEditPreparation {
  readonly explicit: Map<string, Material>;
  state: SelectionState;
  constructor(private readonly operation: WorkspaceOperation, private readonly selection: CanonicalSelection,
    private readonly requiredSources: readonly SourceSelection[], current: ReadonlyMap<string, Material>) {
    this.explicit = new Map([...current].filter(([, material]) => material.record.kind !== 'source' || material.record.selectionOrigin === 'explicit'));
    this.state = selection.state;
  }
  async upsert(selected: SourceSelection) {
    if (selected.kind === 'codemap' && this.operation.runtime.options.copyContext.codeMapsGloballyDisabled) {
      throw new WorkspaceFailure('invalidSelection', { message: 'Codemap generation is disabled; codemap-only selection modes are unavailable.' });
    }
    const id = sourceId(selected.source), required = this.requiredSources.find(value => sourceId(value.source) === id);
    if (required && canonicalJSON(required) !== canonicalJSON(selected)) throw new WorkspaceFailure('requiredMaterialMutation', { id });
    const material = await acquireSource(this.operation, { selectionOrigin: 'explicit', selection: selected, required: required !== undefined });
    const path = selectionPath(this.selection.roots, selected.source);
    const result = await this.operation.transitionSelection({ kind: 'transitionSelection', selection: this.state,
      mutation: { kind: 'representation', target: selected.kind === 'codemap' ? 'codemapOnly' : 'full', paths: [path] } });
    this.state = selected.kind === 'slices' ? { ...result.selection, slices: { ...result.selection.slices, [path]: [...selected.ranges] } } : result.selection;
    this.explicit.set(id, material);
  }
  async remove(source: { readonly root: string; readonly path: string }) {
    const id = sourceId(source);
    if (this.requiredSources.some(value => sourceId(value.source) === id)) throw new WorkspaceFailure('requiredMaterialMutation', { id });
    if (!this.explicit.has(id)) return;
    const result = await this.operation.transitionSelection({ kind: 'transitionSelection', selection: this.state,
      mutation: { kind: 'representation', target: 'unselected', paths: [selectionPath(this.selection.roots, source)] } });
    this.state = result.selection; this.explicit.delete(id);
  }
  async slices(edit: Extract<SourceEdit, { kind: 'slices' }>) {
    const entry = this.operation.snapshot.entries.find(value => value.root === edit.source.root && value.path === edit.source.path);
    if (entry?.kind !== 'file') throw new WorkspaceFailure('unavailableSource', edit.source);
    const path = selectionPath(this.selection.roots, edit.source), base = this.state.slices[path] ?? [];
    const op = edit.op === 'add' ? 'coalesce' : edit.op === 'remove' && edit.ranges.length ? 'subtract' : 'normalize';
    const result = await this.operation.calculateSliceRanges({ kind: 'calculateSliceRanges', op, base, ranges: edit.ranges });
    if (!result.ranges.length && !base.length) return;
    await this.upsert(result.ranges.length ? { kind: 'slices', source: edit.source, ranges: result.ranges } : { kind: 'full', source: edit.source });
  }
  clear(kind: 'clearSources' | 'clearCodemaps') {
    for (const [id, { record }] of this.explicit) {
      if (kind === 'clearSources' && (record.kind === 'gitMap' || record.kind === 'gitPatch')) this.explicit.delete(id);
      if (record.kind === 'source' && !record.required && (kind === 'clearSources' || record.selection.kind === 'codemap')) this.explicit.delete(id);
    }
    const required = new Map([...this.explicit].filter(([, material]) => material.record.kind === 'source' && material.record.required));
    const baseline = capturedState(this.selection.roots, required, this.requiredSources.some(value => value.kind === 'codemap') ? 'manual' : 'automatic');
    this.state = kind === 'clearSources' ? baseline : { ...this.state, manualCodemapPaths: baseline.manualCodemapPaths, codemapAutoEnabled: false };
  }
}

export async function prepareSourceEdits(operation: WorkspaceOperation, edits: readonly SourceEdit[], current: ReadonlyMap<string, Material>,
  selection: CanonicalSelection, requiredSources: readonly SourceSelection[]) {
  const prepared = new SourceEditPreparation(operation, selection, requiredSources, current);
  for (const edit of edits) {
    operation.signal.throwIfAborted();
    switch (edit.kind) {
      case 'upsert': await prepared.upsert(edit.selection); break;
      case 'remove': await prepared.remove(edit.source); break;
      case 'slices': await prepared.slices(edit); break;
      case 'clearSources': case 'clearCodemaps': prepared.clear(edit.kind); break;
    }
  }
  return { explicit: prepared.explicit, state: prepared.state,
    mode: prepared.state.codemapAutoEnabled ? 'automatic' as const : 'manual' as const };
}
