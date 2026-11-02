import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';

/*
 * A stdio MCP server that Pi and omp start under the name `mipmux` in their RPC tests. It offers mipmux's caller tools with
 * open input schemas, appends each call's name and arguments as one JSON line to the file named by MIPMUX_TEST_SERVER_LOG,
 * and answers a build whose outputName is "taken" the way mipmux answers a conflicting retry. A `context_job` wait
 * answers after its `durationMs`, as mipmux does for a job still discovering; a client's cancellation of a waiting call
 * ends it without an answer and appends `{ "cancelled": <the call's arguments> }` to the log.
 */
const RequestId = Type.Union([Type.String(), Type.Number()]);
const Initialize = Compile(Type.Object({ id: RequestId, method: Type.Literal('initialize'), params: Type.Object({ protocolVersion: Type.String() }) }));
const ListTools = Compile(Type.Object({ id: RequestId, method: Type.Literal('tools/list') }));
const ToolCall = Type.Object({ name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) });
const CallTool = Compile(Type.Object({ id: RequestId, method: Type.Literal('tools/call'), params: ToolCall }));
const Wait = Compile(Type.Object({ op: Type.Literal('wait'), jobId: Type.String(), durationMs: Type.Integer({ minimum: 0 }) }));
const Cancelled = Compile(Type.Object({ method: Type.Literal('notifications/cancelled'), params: Type.Object({ requestId: RequestId }) }));
const OtherRequest = Compile(Type.Object({ id: RequestId, method: Type.String() }));
const openInput = { type: 'object', additionalProperties: true };
const tools = ['context_builder', 'context_job', 'context_prepare'].map(name => ({ name, description: `Stand-in for mipmux ${name}`, inputSchema: openInput }));
const methodNotFound = -32601;

function logPath(): string {
  const path = process.env.MIPMUX_TEST_SERVER_LOG;
  if (path === undefined) throw new Error('MIPMUX_TEST_SERVER_LOG names no file');
  return path;
}
const log = logPath();
// Waiting calls by request id, until they answer or are cancelled.
const waiting = new Map<string, { readonly timer: ReturnType<typeof setTimeout>; readonly params: Static<typeof ToolCall> }>();

function text(value: string, isError = false) {
  return { content: [{ type: 'text', text: value }], isError };
}

function send(response: string): void { process.stdout.write(response + '\n'); }

function call(id: Static<typeof RequestId>, params: Static<typeof ToolCall>): void {
  appendFileSync(log, JSON.stringify({ name: params.name, arguments: params.arguments }) + '\n');
  const reply = (result: ReturnType<typeof text>) => send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  if (params.name === 'context_job' && Wait.Check(params.arguments)) {
    const snapshot = JSON.stringify({ jobId: params.arguments.jobId, state: 'discovering' });
    const timer = setTimeout(() => { waiting.delete(String(id)); reply(text(snapshot)); }, params.arguments.durationMs);
    waiting.set(String(id), { timer, params });
    return;
  }
  if (params.name === 'context_job') reply(text(JSON.stringify({ jobId: params.arguments.jobId, state: 'discovering' })));
  else if (params.arguments.outputName === 'taken') reply(text('{"kind":"error","code":"outputNameConflict"}', true));
  else reply(text('{"kind":"started"}'));
}

for await (const line of createInterface({ input: process.stdin })) {
  const message: unknown = JSON.parse(line);
  if (Initialize.Check(message)) {
    send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'mipmux', version: '0.0.0' } } }));
  } else if (ListTools.Check(message)) send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }));
  else if (CallTool.Check(message)) call(message.id, message.params);
  else if (Cancelled.Check(message)) {
    const call = waiting.get(String(message.params.requestId));
    if (call !== undefined) {
      clearTimeout(call.timer);
      waiting.delete(String(message.params.requestId));
      appendFileSync(log, JSON.stringify({ cancelled: call.params.arguments }) + '\n');
    }
  } else if (OtherRequest.Check(message)) {
    send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: methodNotFound, message: `no method ${message.method}` } }));
  }
  // Other notifications carry no id and need no reply.
}
