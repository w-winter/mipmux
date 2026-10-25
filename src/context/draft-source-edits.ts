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
    const result = await this.operation.projectNative({ kind: 'transitionSelection', selection: this.state,
      mutation: { kind: 'representation', target: selected.kind === 'codemap' ? 'codemapOnly' : 'full', paths: [path] } });
    this.state = selected.kind === 'slices' ? { ...result.selection, slices: { ...result.selection.slices, [path]: [...selected.ranges] } } : result.selection;
    this.explicit.set(id, material);
  }
  async remove(source: { readonly root: string; readonly path: string }) {
    const id = sourceId(source);
    if (this.requiredSources.some(value => sourceId(value.source) === id)) throw new WorkspaceFailure('requiredMaterialMutation', { id });
    if (!this.explicit.has(id)) return;
    const result = await this.operation.projectNative({ kind: 'transitionSelection', selection: this.state,
      mutation: { kind: 'representation', target: 'unselected', paths: [selectionPath(this.selection.roots, source)] } });
    this.state = result.selection; this.explicit.delete(id);
  }
  clear(kind: 'clearSources' | 'clearCodemaps') {
    for (const [id, { record }] of this.explicit) {
      if (kind === 'clearSources' && (record.kind === 'gitMap' || record.kind === 'gitPatch')) this.explicit.delete(id);
      if (record.kind === 'source' && !record.required && (kind === 'clearSources' || record.selection.kind === 'codemap')) this.explicit.delete(id);
    }
    const required = new Map([...this.explicit].filter(([, material]) => material.record.kind === 'source' && material.record.required));
    const baseline = capturedState(this.selection.roots, required, 'automatic');
    this.state = kind === 'clearSources' ? baseline : { ...this.state, manualCodemapPaths: baseline.manualCodemapPaths, codemapAutoEnabled: false };
  }
}

export async function prepareSourceEdit(operation: WorkspaceOperation, edit: SourceEdit, current: ReadonlyMap<string, Material>,
  selection: CanonicalSelection, requiredSources: readonly SourceSelection[]) {
  const prepared = new SourceEditPreparation(operation, selection, requiredSources, current);
  operation.signal.throwIfAborted();
  switch (edit.kind) {
    case 'upsert': await prepared.upsert(edit.selection); break;
    case 'remove': await prepared.remove(edit.source); break;
    case 'clearSources': case 'clearCodemaps': prepared.clear(edit.kind); break;
  }
  return { explicit: prepared.explicit, state: prepared.state,
    mode: prepared.state.codemapAutoEnabled ? 'automatic' as const : 'manual' as const };
}
