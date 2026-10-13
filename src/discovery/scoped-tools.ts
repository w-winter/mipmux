import type { DiscoveryCall } from '../contracts/discovery.js';
import type { DraftRuntime } from '../context/draft-runtime.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { pageResult, type ResultEncoding } from '../exploration/output-budget.js';

export async function scopedCall(call: DiscoveryCall, draft: DraftRuntime, operation: WorkspaceOperation,
  signal: AbortSignal, encode: ResultEncoding): Promise<unknown> {
  signal.throwIfAborted();
  switch (call.name) {
    case 'get_file_tree': return call.input.type === 'roots'
      ? operation.getFileTree({ ...call.input, selection: null }, encode)
      : operation.getFileTree({ ...call.input, selection: draft.selectionProjection() }, encode);
    case 'get_code_structure': return operation.getCodeStructure({ ...call.input, selection: draft.selectionProjection() }, encode);
    case 'file_search': return operation.fileSearch(call.input, encode);
    case 'git': return call.input.op === 'diff' && call.input.root === null && call.input.worktree === null
      ? draft.readImplicitGitDiff(call.input, signal, encode) : operation.readGit(call.input, encode);
    case 'read_file': return operation.readFile(call.input, encode);
    case 'draft_preview': return draft.preview(call.input, signal, encode);
    case 'draft_update': return draft.update(call.input, signal, encode);
    case 'draft_inspect': return draft.inspect(call.input, signal, encode);
    case 'prompt': return draft.prompt(call.input, signal, encode);
    case 'manage_selection': return draft.manageSelection(call.input, signal, encode);
    case 'draft_validate': {
      const result = await draft.validate(signal);
      return pageResult(result.costs, 0, call.input.maxOutputBytes, (costs, next) => ({ ...result, costs,
        incompleteDetails: next !== null, costInspection: { draftId: draft.id, revision: result.revision } }), encode);
    }
  }
}
