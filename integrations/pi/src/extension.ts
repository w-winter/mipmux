import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readMipmuxConfig } from './config.ts';
import { createMipmux, entryType } from './register.ts';

/** Registers the /mipmux command and the handlers that apply this session's mipmux choices to the agent's calls. */
export default function mipmux(pi: ExtensionAPI): void {
  const extension = createMipmux({ storePath: join(getAgentDir(), 'mipmux.json'), home: homedir(), readConfig: readMipmuxConfig,
    appendEntry: state => { pi.appendEntry(entryType, state); } });
  pi.on('session_start', (_event, ctx) => extension.restore(ctx));
  pi.on('session_tree', (_event, ctx) => extension.restore(ctx));
  pi.on('before_agent_start', event => extension.beforeAgentStart(event));
  pi.on('tool_call', (event, ctx) => extension.toolCall(event, ctx));
  pi.on('tool_result', event => extension.toolResult(event));
  pi.registerCommand('mipmux', { description: 'Select a saved mipmux workspace and set build preferences',
    getArgumentCompletions: prefix => extension.completions(prefix), handler: (args, ctx) => extension.command(args, ctx) });
}
