import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readMipmuxConfig, readMipmuxModels } from './config.ts';
import { createMipmux, entryType, workspaceSection } from './register.ts';
import { registerSteerableWait } from './wait.ts';

/** Registers the /mipmux command and the handlers that apply this session's mipmux choices to the agent's calls. */
export default function mipmux(pi: ExtensionAPI): void {
  const extension = createMipmux({ storePath: join(getAgentDir(), 'mipmux.json'), home: homedir(), mipmux: { config: readMipmuxConfig, models: readMipmuxModels },
    appendEntry: state => { pi.appendEntry(entryType, state); } });
  pi.on('session_start', (_event, ctx) => extension.restore(ctx));
  pi.on('session_tree', (_event, ctx) => extension.restore(ctx));
  pi.on('before_agent_start', async (event, ctx) => {
    const workspace = await extension.beforeAgentStart(ctx);
    if (workspace !== null) event.systemPromptOptions.sections[workspaceSection] = workspace;
  });
  // Pi runs a call with the arguments as handlers left them, so the edits made in place need no result.
  pi.on('tool_call', async (event, ctx) => {
    const decision = await extension.toolCall(event, ctx);
    return decision.kind === 'blocked' ? { block: true, reason: decision.reason } : undefined;
  });
  pi.on('tool_result', event => {
    const content = extension.toolResult(event);
    if (content === undefined) return undefined;
    return event.structuredContent === undefined ? { content } : { content, structuredContent: event.structuredContent };
  });
  registerSteerableWait(pi);
  pi.registerCommand('mipmux', { description: 'Select a saved mipmux workspace and set build preferences',
    getArgumentCompletions: prefix => extension.completions(prefix), handler: (args, ctx) => extension.command(args, ctx) });
}
