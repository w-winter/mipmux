import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { CallArguments, type CallArgs, type Tool } from './state.ts';

/*
 * The tool names that carry a call to mipmux's context_builder or context_prepare through Pi's tool_call event, whether
 * the model or a codemode script called them. Pi's built-in MCP support registers `mcp__mipmux__<tool>` with the
 * arguments as the event input. pi-mcp-adapter 7, which replaces the built-in support when installed, also offers the
 * `mcp` gateway and the `mcp__mipmux` namespace proxy, with the arguments nested in `args`, and registers direct tools
 * as `mipmux_<tool>`. The extension supports only the server named `mipmux`.
 */
const server = 'mipmux';
const tools: readonly Tool[] = ['context_builder', 'context_prepare'];
/** The names the gateway resolves to a mipmux tool: the tool's own name and its prefixed registrations. */
const spellings = (tool: Tool) => [tool, `${server}_${tool}`, `mcp__${server}__${tool}`];
const Envelope = Compile(Type.Object({ tool: Type.String(), server: Type.Optional(Type.String()),
  args: Type.Optional(Type.Union([Type.String(), CallArguments])) }));
const argumentsValidator = Compile(CallArguments);

/**
 * A mipmux build or prepare call: its arguments, mutable in place, and `commit`, which writes changed arguments back to
 * the event. A gateway call whose `args` text is not a JSON object is `malformed`, so the hook can block it with a reason.
 */
export type RecognizedCall = { readonly kind: 'call'; readonly tool: Tool; readonly args: CallArgs; commit(): void } |
  { readonly kind: 'malformed'; readonly reason: string };

function toolNamed(name: string, accepted: (tool: Tool) => readonly string[]): Tool | null {
  return tools.find(tool => accepted(tool).includes(name)) ?? null;
}

function parsedArguments(text: string): CallArgs | string {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { return error instanceof Error ? error.message : 'unparseable text'; }
  return argumentsValidator.Check(parsed) ? parsed : 'the text is not a JSON object';
}

/** The mipmux build or prepare call an event carries, or null for every other tool, server or envelope. */
export function recognize(toolName: string, input: CallArgs): RecognizedCall | null {
  const direct = toolNamed(toolName, tool => [`mcp__${server}__${tool}`, `${server}_${tool}`]);
  if (direct) return { kind: 'call', tool: direct, args: input, commit: () => {} };
  if (toolName !== 'mcp' && toolName !== `mcp__${server}`) return null;
  if (!Envelope.Check(input)) return null;
  // The gateway takes a server only optionally; the namespace proxy is the server.
  if (toolName === 'mcp' && input.server !== undefined && input.server !== server) return null;
  const tool = toolNamed(input.tool, spellings);
  if (!tool) return null;
  const raw = input.args;
  if (raw === undefined) {
    const args: CallArgs = {};
    return { kind: 'call', tool, args, commit: () => { input.args = args; } };
  }
  if (argumentsValidator.Check(raw)) return { kind: 'call', tool, args: raw, commit: () => {} };
  const args = parsedArguments(raw);
  if (!argumentsValidator.Check(args)) return { kind: 'malformed', reason: `The mipmux ${tool} arguments are not valid JSON: ${args}.` };
  return { kind: 'call', tool, args, commit: () => { input.args = JSON.stringify(args); } };
}
