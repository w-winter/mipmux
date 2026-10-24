import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/client';

/** A value that JSON text encodes. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** The JSON value of a mipmux MCP tool result, which arrives as exactly one text block. */
export function toolJSON(result: CallToolResult): JsonValue {
  const [block, ...rest] = result.content;
  assert(block?.type === 'text' && rest.length === 0, 'Expected one text block');
  return JSON.parse(block.text);
}
