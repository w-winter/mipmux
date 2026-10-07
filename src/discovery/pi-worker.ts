import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { callValidator, toolSchemas } from '../contracts/discovery.js';
import { toolDescription } from '../contracts/exploration.js';
import { parentValidator, type ParentMessage } from './pi-protocol.js';
import { receive, send } from './pi-channel.js';
import { runPiSession } from './pi-session.js';
import { piToolResult } from '../runtime/tool-result.js';

const controller = new AbortController();
let start: Extract<ParentMessage, { kind: 'start' }> | null = null;
const pending = new Map<string, (value: Extract<ParentMessage, { kind: 'toolResult' }>) => void>();
const fail = () => { controller.abort(); process.exitCode = 1; process.stdin.destroy(); };
process.on('SIGTERM', () => controller.abort());
process.stdin.on('end', () => controller.abort());
process.stdout.on('error', fail);
receive(process.stdin, value => {
  if (!parentValidator.Check(value)) throw new Error('Invalid parent message');
  if (value.kind === 'start') {
    if (start) throw new Error('Duplicate start');
    start = value;
    const scope = { generation: value.generation, job: value.job };
    const tools: ToolDefinition[] = Object.entries(toolSchemas).map(([name, parameters]) => ({
      name, label: name, description: toolDescription(name), parameters,
      execute: async (_id, input, signal) => {
        controller.signal.throwIfAborted(); signal?.throwIfAborted();
        const call = callValidator.Default({ name, input });
        if (!callValidator.Check(call)) throw new Error('invalidRequest');
        const id = randomUUID();
        const response = new Promise<Extract<ParentMessage, { kind: 'toolResult' }>>(resolve => pending.set(id, resolve));
        send(process.stdout, { ...scope, kind: 'tool', id, call });
        const result = await response;
        return { ...piToolResult(result.value), details: undefined, isError: result.failed };
      },
    }));
    void runPiSession(value.config, value.input, tools, value.prompt, value.mcp, controller.signal,
      event => send(process.stdout, { ...scope, kind: 'progress', event }),
      fact => send(process.stdout, { ...scope, kind: 'evidence', fact })).then(result => {
        // Native background startup is unjoined; exiting releases local HTTP sockets after the terminal flush.
        send(process.stdout, { ...scope, kind: 'complete', ...result }, value.mcp ? () => process.exit() : undefined);
        process.stdin.destroy();
      }, fail);
  } else {
    if (!start || start.job !== value.job || start.generation !== value.generation) throw new Error('Wrong scope');
    if (value.kind === 'abort') controller.abort();
    else {
      const resolve = pending.get(value.id);
      if (!resolve) throw new Error('Unknown tool call');
      pending.delete(value.id); resolve(value);
    }
  }
}, fail);
