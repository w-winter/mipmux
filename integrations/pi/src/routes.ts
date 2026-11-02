import type { Tool } from './state.ts';

/*
 * Pi's built-in MCP support registers each tool of the server named `mipmux` as `mcp__mipmux__<tool>` and passes the
 * call's arguments as the tool_call event's input, whether the model or a codemode script calls it.
 */
const tools: readonly Tool[] = ['context_builder', 'context_prepare'];

/** The mipmux build or prepare tool an event's tool name calls, or null for every other tool or server. */
export function recognize(toolName: string): Tool | null {
  return tools.find(tool => toolName === `mcp__mipmux__${tool}`) ?? null;
}
