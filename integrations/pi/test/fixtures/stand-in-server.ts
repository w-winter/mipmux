import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';

/*
 * A stdio MCP server that Pi and omp start under the name `mipmux` in their RPC tests. It offers mipmux's caller tools with
 * open input schemas, appends each call's name and arguments as one JSON line to the file named by MIPMUX_TEST_SERVER_LOG,
 * and answers a build whose outputName is "taken" the way mipmux answers a conflicting retry.
 */
const RequestId = Type.Union([Type.String(), Type.Number()]);
const Initialize = Compile(Type.Object({ id: RequestId, method: Type.Literal('initialize'), params: Type.Object({ protocolVersion: Type.String() }) }));
const ListTools = Compile(Type.Object({ id: RequestId, method: Type.Literal('tools/list') }));
const ToolCall = Type.Object({ name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) });
const CallTool = Compile(Type.Object({ id: RequestId, method: Type.Literal('tools/call'), params: ToolCall }));
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

function call(params: Static<typeof ToolCall>) {
  appendFileSync(log, JSON.stringify({ name: params.name, arguments: params.arguments }) + '\n');
  const conflict = params.arguments.outputName === 'taken';
  return { content: [{ type: 'text', text: conflict ? '{"kind":"error","code":"outputNameConflict"}' : '{"kind":"started"}' }], isError: conflict };
}

function send(response: string): void { process.stdout.write(response + '\n'); }

for await (const line of createInterface({ input: process.stdin })) {
  const message: unknown = JSON.parse(line);
  if (Initialize.Check(message)) {
    send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'mipmux', version: '0.0.0' } } }));
  } else if (ListTools.Check(message)) send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }));
  else if (CallTool.Check(message)) send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: call(message.params) }));
  else if (OtherRequest.Check(message)) {
    send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: methodNotFound, message: `no method ${message.method}` } }));
  }
  // Notifications carry no id and need no reply.
}
