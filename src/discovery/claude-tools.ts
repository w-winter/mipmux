import { Compile } from 'typebox/compile';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, fromJsonSchema, type CallToolResult } from '@modelcontextprotocol/server';
import { canonicalJSON, sha256, WorkspaceFailure } from '../workspace/values.js';
import { JsonObject } from './advertised-schema.js';
import { decodeLiteral, type AdmittedMcp } from './mcp-config.js';

/** Claude Code keeps every tool of these servers in the prompt rather than deferring it behind tool search. */
const alwaysLoad = { 'anthropic/alwaysLoad': true };
/** Pi's default per-request timeout for an MCP server, in seconds; the configuration's `timeout` overrides it. */
const defaultMcpTimeoutSeconds = 60;

const jsonObject = Compile(JsonObject);

/** A tool mipmux serves to Claude Code: its name, description and JSON Schema, and the call that answers it. */
export interface ServedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  call(input: JsonObject, signal: AbortSignal): Promise<CallToolResult>;
}

/** An MCP server, for the Claude Agent SDK to run in this process, that serves `tools` and keeps them all in the prompt. */
export function servedToolServer(name: string, tools: readonly ServedTool[]): McpServer {
  const server = new McpServer({ name, version: '1' });
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema), _meta: alwaysLoad },
      (input, ctx) => tool.call(jsonObject.Parse(input), ctx.mcpReq.signal));
  }
  return server;
}

/** The allowlisted tools of a run's external MCP servers, connected by mipmux; `close` disconnects every server. */
export interface ExternalTools {
  readonly servers: ReadonlyMap<string, readonly ServedTool[]>;
  /** The SHA-256 of the served declarations, sorted by server and tool. */
  readonly declarationSHA256: string;
  close(): Promise<void>;
}

async function listAllTools(client: Client, signal: AbortSignal) {
  const tools = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor }, { signal });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

async function connectServer(name: string, config: AdmittedMcp['configuration']['mcpServers'][string], clients: Client[], signal: AbortSignal) {
  if (config.oauth) throw new WorkspaceFailure('mcpOAuthUnsupported', { server: name });
  const headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([header, value]) => [header, decodeLiteral(value)]));
  const client = new Client({ name: 'mipmux', version: '1' });
  clients.push(client);
  const timeout = (config.timeout ?? defaultMcpTimeoutSeconds) * 1000;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } }), { signal, timeout });
    const listed = await listAllTools(client, signal);
    return Object.keys(config.toolExposure).sort().map((toolName): ServedTool => {
      const tool = listed.find(candidate => candidate.name === toolName);
      if (!tool) throw new WorkspaceFailure('mcpToolsUnavailable', { server: name, tool: toolName });
      return { name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
        call: (input, callSignal) => client.callTool({ name: tool.name, arguments: input }, { signal: callSignal, timeout, resetTimeoutOnProgress: true }) };
    });
  } catch (cause) {
    signal.throwIfAborted();
    if (cause instanceof WorkspaceFailure) throw cause;
    throw Object.defineProperty(new WorkspaceFailure('mcpToolsUnavailable', { server: name }), 'cause', { value: cause });
  }
}

/**
 * Connects every server of an admitted MCP configuration over Streamable HTTP with its literal headers and checks that it
 * offers each allowlisted tool. A server configured for OAuth fails with mcpOAuthUnsupported; an unreachable or refusing
 * server, or a missing tool, fails with mcpToolsUnavailable. Every server connected so far is closed on failure.
 */
export async function connectExternalTools(mcp: AdmittedMcp, signal: AbortSignal): Promise<ExternalTools> {
  const clients: Client[] = [];
  const close = async () => { await Promise.allSettled(clients.map(client => client.close())); };
  try {
    const servers = new Map<string, readonly ServedTool[]>();
    for (const [name, config] of Object.entries(mcp.configuration.mcpServers).sort(([a], [b]) => a.localeCompare(b))) {
      servers.set(name, await connectServer(name, config, clients, signal));
    }
    const declarations = [...servers].flatMap(([server, tools]) => tools.map(tool => ({ server, name: tool.name, description: tool.description,
      inputSchema: tool.inputSchema })));
    return { servers, declarationSHA256: sha256(canonicalJSON(declarations)), close };
  } catch (error) {
    await close();
    throw error;
  }
}
