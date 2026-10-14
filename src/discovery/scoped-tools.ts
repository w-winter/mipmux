import type { DiscoveryCall } from '../contracts/discovery.js';
import type { DraftRuntime } from '../context/draft-runtime.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { pageResult, type ResultEncoding } from '../exploration/output-budget.js';
import type { GitRequest } from '../contracts/git.js';
import { WorkspaceFailure } from '../workspace/values.js';

export function scopedGitCall(input: GitRequest, draft: DraftRuntime | null, operation: WorkspaceOperation,
  signal: AbortSignal, encode: ResultEncoding) {
  if (input.op === 'diff' && input.artifacts) {
    if (!draft) throw new WorkspaceFailure('draftRequired');
    return draft.publishGitArtifacts(input, signal, encode);
  }
  return input.op === 'diff' && input.root === null && input.worktree === null && draft
    ? draft.readImplicitGitDiff(input, signal, encode) : operation.readGit(input, encode);
}

export async function scopedCall(call: DiscoveryCall, draft: DraftRuntime, operation: WorkspaceOperation,
  signal: AbortSignal, encode: ResultEncoding): Promise<unknown> {
  signal.throwIfAborted();
  switch (call.name) {
    case 'get_file_tree': return call.input.type === 'roots'
      ? operation.getFileTree({ ...call.input, selection: null }, encode)
      : operation.getFileTree({ ...call.input, selection: draft.selectionProjection() }, encode);
    case 'get_code_structure': return operation.getCodeStructure({ ...call.input, selection: draft.selectionProjection() }, encode);
    case 'file_search': return operation.fileSearch(call.input, encode);
    case 'git': return scopedGitCall(call.input, draft, operation, signal, encode);
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
