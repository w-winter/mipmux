import type { Tool } from './state.ts';

/*
 * omp's built-in MCP support registers each tool of the server named `mipmux` as `mcp__mipmux_<tool>`: it lowercases the
 * server and tool names and joins them with one underscore (`createMCPToolName`), and passes the call's arguments as the
 * tool_call event's input.
 */
const tools: readonly Tool[] = ['context_builder', 'context_prepare'];

/** The mipmux build or prepare tool an event's tool name calls, or null for every other tool or server. */
export function recognize(toolName: string): Tool | null {
  return tools.find(tool => toolName === `mcp__mipmux_${tool}`) ?? null;
}
