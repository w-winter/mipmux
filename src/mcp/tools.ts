import Type, { type Static, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { fromJsonSchema, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { WorkspaceSpec } from '../contracts/inventory.js';
import { ContextBuildRequest, DraftInspection, DraftUpdate, DraftPreview, PromptRequest } from '../contracts/context.js';
import { ReadInput, SearchInput, StructureInput, readValidator, searchValidator, ScopedStructure, toolDescription } from '../contracts/exploration.js';
import { GitInput, gitValidator } from '../contracts/git.js';
import { Positive, TreeInput, ScopedTree } from '../contracts/discovery.js';
import type { ClientRuntime } from '../runtime/client-runtime.js';
import { toolResult, failureResult } from '../runtime/tool-result.js';
import { WorkspaceFailure } from '../workspace/values.js';

const closed = { additionalProperties: false }, id = Type.String({ minLength: 1 });
export function registerTools(server: McpServer, client: () => ClientRuntime, defaultMaxOutputBytes: number) {
  const budget = { maxOutputBytes: Type.Optional(Positive) };
  function register<S extends TSchema>(name: string, schema: S,
    execute: (input: Static<S>, context: ServerContext) => unknown | Promise<unknown>) {
    const check = Compile(schema);
    server.registerTool(name, { description: toolDescription(name), inputSchema: fromJsonSchema(schema) }, async (input, context) => {
      try {
        if (!check.Check(input)) throw new WorkspaceFailure('invalidRequest');
        return toolResult(await execute(input, context));
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
  register('git', Type.Object({ workspaceId: id, input: GitInput, ...budget }, closed),
    (input, ctx) => {
      const request = gitValidator.Parse(gitValidator.Default({ ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }));
      return client().explore(input.workspaceId, { name: 'git', input: request }, ctx.mcpReq.signal, null, toolResult);
    });
  register('read_file', Type.Object({ workspaceId: id, input: ReadInput, ...budget }, closed),
    (input, ctx) => {
      const request = readValidator.Parse(readValidator.Default({ ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }));
      return client().explore(input.workspaceId, { name: 'read_file', input: request }, ctx.mcpReq.signal, null, toolResult);
    });
  register('file_search', Type.Object({ workspaceId: id, input: SearchInput, ...budget }, closed),
    (input, ctx) => {
      const request = searchValidator.Parse(searchValidator.Default({ ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }));
      return client().explore(input.workspaceId, { name: 'file_search', input: request }, ctx.mcpReq.signal, null, toolResult);
    });
  register('draft_create', Type.Object({ workspaceId: id, request: ContextBuildRequest }, closed),
    (input, ctx) => client().createDraft(input.workspaceId, input.request, ctx.mcpReq.signal));
  register('draft_inspect', Type.Object({ draftId: id, input: Type.Union([
    Type.Omit(DraftInspection.anyOf[0], ['maxOutputBytes']), Type.Omit(DraftInspection.anyOf[1], ['maxOutputBytes']),
  ]), ...budget }, closed),
    input => client().inspect(input.draftId, { ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }, toolResult));
  register('draft_update', Type.Object({ draftId: id, input: Type.Omit(DraftUpdate, ['maxOutputBytes']), ...budget }, closed),
    (input, ctx) => client().update(input.draftId, { ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }, ctx.mcpReq.signal, toolResult));
  register('draft_preview', Type.Object({ draftId: id, input: Type.Omit(DraftPreview, ['maxOutputBytes']), ...budget }, closed),
    (input, ctx) => client().preview(input.draftId, { ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }, ctx.mcpReq.signal, toolResult));
  register('prompt', Type.Object({ draftId: id, input: Type.Union([
    Type.Omit(PromptRequest.anyOf[0], ['maxOutputBytes']), Type.Omit(PromptRequest.anyOf[1], ['maxOutputBytes']),
    Type.Omit(PromptRequest.anyOf[2], ['maxOutputBytes']), Type.Omit(PromptRequest.anyOf[3], ['maxOutputBytes']),
  ]), ...budget }, closed),
    (input, ctx) => client().prompt(input.draftId, { ...input.input, maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes }, ctx.mcpReq.signal, toolResult));
  register('draft_validate', Type.Object({ draftId: id, ...budget }, closed),
    (input, ctx) => client().validate(input.draftId, input.maxOutputBytes ?? defaultMaxOutputBytes, ctx.mcpReq.signal, toolResult));
  register('draft_finalize', Type.Object({ draftId: id }, closed), (input, ctx) => client().finalize(input.draftId, ctx.mcpReq.signal));
  register('context_builder', Type.Object({ workspaceId: id, requestId: id, request: ContextBuildRequest }, closed),
    input => client().build(input.workspaceId, input.requestId, input.request));
  register('context_builder_result', Type.Object({ jobId: id }, closed), input => client().result(input.jobId));
  register('context_builder_cancel', Type.Object({ jobId: id }, closed), input => client().cancel(input.jobId));
  register('context_builder_wait', Type.Object({ jobId: id, durationMs: Type.Integer({ minimum: 0, maximum: 2147483647 }) }, closed),
    async (input, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      return await client().wait(input.jobId, input.durationMs, ctx.mcpReq.signal, snapshot => {
        if (progressToken !== undefined) void ctx.mcpReq.notify({ method: 'notifications/progress',
          params: { progressToken, progress: snapshot.sequence, message: snapshot.state } }).catch(() => {});
      });
    });
}
