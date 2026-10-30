import Type, { type Static, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { fromJsonSchema, inputRequired, isInputRequiredResult, CLIENT_CAPABILITIES_META_KEY,
  type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { WorkspaceSpec } from '../contracts/inventory.js';
import { ContextBuildRequest, DraftInspection, DraftUpdate, PromptRequest } from '../contracts/context.js';
import { CallerBuildRequest, CallerJobInput, CallerJobRequest, CallerPrepareRequest } from '../contracts/caller-context.js';
import { ReadInput, SearchInput, StructureInput, readValidator, searchValidator, ScopedStructure, toolDescription } from '../contracts/exploration.js';
import { GitInput, gitValidator } from '../contracts/git.js';
import { SelectionInput, selectionValidator } from '../contracts/selection.js';
import { Positive, TreeInput, ScopedTree } from '../contracts/discovery.js';
import type { ClientRuntime } from '../runtime/client-runtime.js';
import { toolResult, failureResult } from '../runtime/tool-result.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { ClientQuestionResponse } from '../contracts/interaction.js';
import { questionForm, sourceQuestionResponse } from './question-form.js';
import { jobReceipt, prepareReceipt, publicationReceipt } from './receipts.js';
import type { ToolSet } from '../cli/config.js';

const closed = { additionalProperties: false }, id = Type.String({ minLength: 1 });
const formCapability = Compile(Type.Object({ [CLIENT_CAPABILITIES_META_KEY]: Type.Object({
  elicitation: Type.Object({ form: Type.Object({}) }),
}) }));
const questionResponses = Compile(Type.Record(Type.String(), ClientQuestionResponse));
const jobRequest = Compile(CallerJobRequest);
/** The tools the agent workflow in docs/workflow.md uses; the `full` set registers every tool. */
const coreTools: ReadonlySet<string> = new Set(['context_builder', 'context_job', 'context_prepare']);

/**
 * Waits for a job, first applying the one answer `inputResponses` may carry for its current question. Returns the job's
 * snapshot, or a form when a question is pending; without form capability a pending question fails with elicitationUnavailable.
 */
async function waitForJob(client: ClientRuntime, jobId: string, durationMs: number, ctx: ServerContext) {
  if (ctx.mcpReq.inputResponses !== undefined) {
    if (!questionResponses.Check(ctx.mcpReq.inputResponses)) throw new WorkspaceFailure('invalidInteractionResponse');
    const entries = Object.entries(ctx.mcpReq.inputResponses);
    if (entries.length !== 1) throw new WorkspaceFailure('invalidInteractionResponse');
    const [questionId, response] = entries[0]!;
    const question = client.pendingQuestion(jobId);
    if (!question || question.id !== questionId) throw new WorkspaceFailure('interactionNotCurrent');
    client.answerQuestion(jobId, questionId, sourceQuestionResponse(question, response));
  }
  const progressToken = ctx.mcpReq._meta?.progressToken;
  const result = await client.wait(jobId, durationMs, ctx.mcpReq.signal, snapshot => {
    if (progressToken !== undefined) void ctx.mcpReq.notify({ method: 'notifications/progress',
      params: { progressToken, progress: snapshot.sequence, message: snapshot.state } }).catch(() => {});
  });
  const question = client.pendingQuestion(jobId);
  if (!question) return jobReceipt(result);
  if (!formCapability.Check(ctx.mcpReq.envelope)) throw new WorkspaceFailure('elicitationUnavailable');
  return inputRequired({ inputRequests: { [question.id]: inputRequired.elicit(questionForm(question)) } });
}

/**
 * Dispatches one job operation. The advertised schema cannot say that only `wait` takes `durationMs`, so the union check
 * here does. Only a wait may answer a question, so a status, cancel or dispose call that carries an answer fails without effect.
 */
function controlJob(client: ClientRuntime, input: CallerJobInput, ctx: ServerContext) {
  if (!jobRequest.Check(input)) throw new WorkspaceFailure('invalidRequest', { message: 'durationMs is required for wait and not accepted by status, cancel or dispose.' });
  if (input.op === 'wait') return waitForJob(client, input.jobId, input.durationMs, ctx);
  if (ctx.mcpReq.inputResponses !== undefined) throw new WorkspaceFailure('invalidInteractionResponse');
  switch (input.op) {
    case 'status': return jobReceipt(client.result(input.jobId));
    case 'cancel': {
      const result = client.cancel(input.jobId);
      return 'localSettled' in result ? jobReceipt(result) : result;
    }
    case 'dispose': return client.disposeJob(input.jobId, ctx.mcpReq.signal);
  }
}
export function registerTools(server: McpServer, client: () => ClientRuntime, defaultMaxOutputBytes: number, toolSet: ToolSet) {
  const budget = { maxOutputBytes: Type.Optional(Positive) };
  function register<S extends TSchema>(name: string, schema: S,
    execute: (input: Static<S>, context: ServerContext) => unknown | Promise<unknown>) {
    if (toolSet === 'core' && !coreTools.has(name)) return;
    const check = Compile(schema);
    server.registerTool(name, { description: toolDescription(name), inputSchema: fromJsonSchema(schema) }, async (input, context) => {
      try {
        if (!check.Check(input)) throw new WorkspaceFailure('invalidRequest');
        const result = await execute(input, context);
        return isInputRequiredResult(result) ? result : toolResult(result);
      } catch (error) {
        return { ...toolResult(failureResult(error)), isError: true };
      }
    });
  }
  register('workspace_declare', Type.Object({ spec: WorkspaceSpec }, closed), (input, ctx) => client().declare(input.spec, ctx.mcpReq.signal));
  register('workspace_refresh', Type.Object({ workspaceId: id }, closed), (input, ctx) => client().refresh(input.workspaceId, ctx.mcpReq.signal));
  register('workspace_close', Type.Object({ workspaceId: id }, closed), async input => { await client().closeWorkspace(input.workspaceId); return { kind: 'closed' }; });
  const scopedTreeValidator = Compile(ScopedTree);
  register('get_file_tree', Type.Object({ workspaceId: id, input: Type.Optional(TreeInput), draftId: Type.Optional(Type.Union([id, Type.Null()])), ...budget }, closed),
    (input, ctx) => {
      const request = scopedTreeValidator.Parse(scopedTreeValidator.Default({ ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }));
      return client().explore(input.workspaceId, { name: 'get_file_tree', input: request }, ctx.mcpReq.signal, input.draftId ?? null, toolResult);
    });
  const scopedStructureValidator = Compile(ScopedStructure);
  register('get_code_structure', Type.Object({ workspaceId: id, input: Type.Optional(StructureInput),
    draftId: Type.Optional(Type.Union([id, Type.Null()])), ...budget }, closed),
    (input, ctx) => {
      const request = scopedStructureValidator.Parse(scopedStructureValidator.Default({ ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }));
      return client().explore(input.workspaceId, { name: 'get_code_structure', input: request }, ctx.mcpReq.signal, input.draftId ?? null, toolResult);
    });
  register('git', Type.Object({ workspaceId: id, input: GitInput, draftId: Type.Optional(Type.Union([id, Type.Null()])), ...budget }, closed),
    (input, ctx) => {
      const request = gitValidator.Parse(gitValidator.Default({ ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }));
      return client().explore(input.workspaceId, { name: 'git', input: request }, ctx.mcpReq.signal, input.draftId ?? null, toolResult);
    });
  register('read_file', Type.Object({ workspaceId: id, input: ReadInput, draftId: Type.Optional(Type.Union([id, Type.Null()])), ...budget }, closed),
    (input, ctx) => {
      const request = readValidator.Parse(readValidator.Default({ ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }));
      return client().explore(input.workspaceId, { name: 'read_file', input: request }, ctx.mcpReq.signal, input.draftId ?? null, toolResult);
    });
  register('file_search', Type.Object({ workspaceId: id, input: SearchInput, ...budget }, closed),
    (input, ctx) => {
      const request = searchValidator.Parse(searchValidator.Default({ ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }));
      return client().explore(input.workspaceId, { name: 'file_search', input: request }, ctx.mcpReq.signal, null, toolResult);
    });
  register('draft_create', Type.Object({ workspaceId: id, request: ContextBuildRequest }, closed),
    (input, ctx) => client().createDraft(input.workspaceId, input.request, ctx.mcpReq.signal));
  register('manage_selection', Type.Object({ draftId: id, input: Type.Optional(SelectionInput), ...budget }, closed),
    (input, ctx) => client().manageSelection(input.draftId,
      selectionValidator.Parse(selectionValidator.Default({ ...input.input,
        maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes })), ctx.mcpReq.signal, toolResult));
  register('draft_inspect', Type.Object({ draftId: id, input: Type.Union([
    Type.Omit(DraftInspection.anyOf[0], ['maxOutputBytes']), Type.Omit(DraftInspection.anyOf[1], ['maxOutputBytes']),
  ]), ...budget }, closed),
    (input, ctx) => client().inspect(input.draftId, { ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }, ctx.mcpReq.signal, toolResult));
  register('draft_update', Type.Object({ draftId: id, input: Type.Omit(DraftUpdate, ['maxOutputBytes']), ...budget }, closed),
    (input, ctx) => client().update(input.draftId, { ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }, ctx.mcpReq.signal, toolResult));
  register('prompt', Type.Object({ draftId: Type.Optional(id), input: Type.Union([
    Type.Omit(PromptRequest.anyOf[0], ['maxOutputBytes']), Type.Omit(PromptRequest.anyOf[1], ['maxOutputBytes']),
    Type.Omit(PromptRequest.anyOf[2], ['maxOutputBytes']), Type.Omit(PromptRequest.anyOf[3], ['maxOutputBytes']),
    Type.Omit(PromptRequest.anyOf[4], ['maxOutputBytes']), Type.Omit(PromptRequest.anyOf[5], ['maxOutputBytes']),
  ]), ...budget }, closed),
    (input, ctx) => client().prompt(input.draftId ?? null, { ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }, ctx.mcpReq.signal, toolResult));
  register('draft_validate', Type.Object({ draftId: id, ...budget }, closed),
    (input, ctx) => client().validate(input.draftId, input.maxOutputBytes ?? defaultMaxOutputBytes, ctx.mcpReq.signal, toolResult));
  register('draft_finalize', Type.Object({ draftId: id }, closed), async (input, ctx) => publicationReceipt(await client().finalize(input.draftId, ctx.mcpReq.signal)));
  register('draft_dispose', Type.Object({ draftId: id }, closed), (input, ctx) => client().disposeDraft(input.draftId, ctx.mcpReq.signal));
  register('context_builder', CallerBuildRequest, async (input, ctx) => jobReceipt(await client().buildContext(input, ctx.mcpReq.signal,
    formCapability.Check(ctx.mcpReq.envelope) ? 'form' : 'unavailable')));
  register('context_job', CallerJobInput, (input, ctx) => controlJob(client(), input, ctx));
  register('context_prepare', CallerPrepareRequest, async (input, ctx) => prepareReceipt(await client().prepareContext(input, ctx.mcpReq.signal)));
}
