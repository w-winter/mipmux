import type { DiscoveryCall } from '../contracts/discovery.js';
import type { DraftRuntime } from '../context/draft-runtime.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { pageResult, type ResultEncoding } from '../exploration/output-budget.js';
import type { GitRequest } from '../contracts/git.js';
import type { ReadRequest } from '../contracts/exploration.js';
import { WorkspaceFailure } from '../workspace/values.js';

export function scopedGitCall(input: GitRequest, draft: DraftRuntime | null, operation: WorkspaceOperation,
  signal: AbortSignal, encode: ResultEncoding) {
  if (input.op === 'diff' && input.artifacts) {
    if (!draft) throw new WorkspaceFailure('draftRequired');
    return draft.publishGitArtifacts(input, signal, encode);
  }
  return draft && (input.op !== 'diff' || input.root === null && input.worktree === null)
    ? draft.readScopedGit(input, signal, encode) : operation.readGit(input, encode);
}

export function scopedReadCall(input: ReadRequest, draft: DraftRuntime | null, operation: WorkspaceOperation,
  signal: AbortSignal, encode: ResultEncoding) {
  if (input.root !== null) return operation.readFile(input, encode);
  if (!draft) throw new WorkspaceFailure('draftRequired');
  return draft.readSelectedGitArtifact(input, signal, encode);
}

export async function scopedCall(call: Exclude<DiscoveryCall, { name: 'ask_user' }>, draft: DraftRuntime, operation: WorkspaceOperation,
  signal: AbortSignal, encode: ResultEncoding): Promise<unknown> {
  signal.throwIfAborted();
  switch (call.name) {
    case 'get_file_tree': return call.input.type === 'roots'
      ? operation.getFileTree({ ...call.input, selection: null }, encode)
      : operation.getFileTree({ ...call.input, selection: draft.selectionProjection() }, encode);
    case 'get_code_structure': return operation.getCodeStructure({ ...call.input, selection: draft.selectionProjection() }, encode);
    case 'file_search': return operation.fileSearch(call.input, encode);
    case 'git': return scopedGitCall(call.input, draft, operation, signal, encode);
    case 'read_file': return scopedReadCall(call.input, draft, operation, signal, encode);
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
