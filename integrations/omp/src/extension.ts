import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { readMipmuxConfig, readMipmuxModels } from './config.ts';
import { createMipmux, entryType, workspaceSection } from './register.ts';
import { recognize } from './routes.ts';
import type { CallArgs } from './state.ts';

/** Registers the /mipmux command and the handlers that apply this session's mipmux choices to the agent's calls. */
export default function mipmux(pi: ExtensionAPI): void {
  const extension = createMipmux({ storePath: join(getAgentDir(), 'mipmux.json'), home: homedir(), mipmux: { config: readMipmuxConfig, models: readMipmuxModels },
    appendEntry: state => { pi.appendEntry(entryType, state); } });
  pi.on('session_start', (_event, ctx) => extension.restore(ctx));
  pi.on('session_tree', (_event, ctx) => extension.restore(ctx));
  // omp sends the prompt blocks the last handler returns, and each handler receives the blocks returned before it.
  pi.on('before_agent_start', async (event, ctx) => {
    const workspace = await extension.beforeAgentStart(ctx);
    if (workspace === null) return undefined;
    return { systemPrompt: [...event.systemPrompt, `<${workspaceSection}>\n${workspace}\n</${workspaceSection}>`] };
  });
  // omp runs a call with the input a handler returns, so the shared rules edit a copy, which is returned when they changed it.
  pi.on('tool_call', async (event, ctx) => {
    if (recognize(event.toolName) === null) return undefined;
    const input: CallArgs = structuredClone({ ...event.input });
    const decision = await extension.toolCall({ toolName: event.toolName, toolCallId: event.toolCallId, input }, ctx);
    if (decision.kind === 'blocked') return { block: true, reason: decision.reason };
    return decision.changed ? { input } : undefined;
  });
  pi.on('tool_result', event => {
    const content = extension.toolResult(event);
    return content === undefined ? undefined : { content };
  });
  pi.registerCommand('mipmux', { description: 'Select a saved mipmux workspace and set build preferences',
    getArgumentCompletions: prefix => extension.completions(prefix), handler: (args, ctx) => extension.command(args, ctx) });
}
