import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { compose, hostValidator, type HostConfig } from '../cli/config.js';
import { registerTools } from './tools.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';

/**
 * Sent at initialization for the client to show its model. Claude Code before 2.1.296 keeps 2,048 characters, Codex
 * favors the first 512 and Pi previews 300, so the summary comes first and the whole text stays under 2,048.
 */
const instructions = [
  'mipmux builds verified context packets for coding agents. It indexes the folders you declare, runs a discovery agent '
    + 'that selects the files, code maps and Git patches a task needs, and saves them as one context.md for a planning, review '
    + 'or investigation model.',
  '',
  'To build a packet:',
  '1. Use one existing output folder per project, such as <repository>/prompt-exports, for every run. mipmux never indexes it.',
  '2. Call workspace_declare with spec { roots: [{ name, absolutePath }], exclusions: [], outputRoot }. Keep the returned id. '
    + 'If a later call fails with unknownWorkspace, declare the same spec again.',
  '3. Call context_builder with workspaceId, a new requestId and a request: purpose (planning, review or investigation); '
    + 'copyPreset ("codeReview" when the packet needs patches, otherwise "standard"); task (the whole request, with roots, Git '
    + 'comparisons, changed files, plan paths and the recipient); constraints ""; requiredSources for files that must appear in '
    + 'full; patches as localPatch entries for reviews; documents for text outside the roots; initialSelection { codemapMode: '
    + '"automatic", sources: [] }; discoveryHints []; duplicateUserInstructionsAtTop false; and a new outputName that starts '
    + 'with a run ID. Omit budgetUnits unless the user sets one.',
  '4. Call context_builder_wait with the jobId and a durationMs below your tool-call timeout. Repeat until the state is ready, '
    + 'blocked, failed or cancelled. Never start a second job for the same work.',
  '5. Check the ready receipt\'s materials and omitted lists. Do not read context.md into your own context.',
  '6. Call context_prepare with workspaceId, the ready bundle\'s directory name as bundle, the complete final task as prompt '
    + 'and a new outputName. It checks the packet against current files and makes no model call.',
  '7. Give the recipient the prepared bundle\'s context.md.',
  '',
  'Full guide: https://github.com/w-winter/mipmux/blob/main/docs/workflow.md',
].join('\n');

/** Factory construction validates structure only. Resources are admitted on the first tool call. */
export function createMcpServer(input: HostConfig, configurationPath: string | null = null) {
  if (!hostValidator.Check(input)) throw new WorkspaceFailure('invalidConfiguration');
  const config = freeze(structuredClone(input));
  const state: { application: ReturnType<typeof compose> | null; closing: Promise<void> | null } = { application: null, closing: null };
  const server = new McpServer({ name: 'mipmux', version: '0.1.0' }, { instructions });
  let settled!: () => void, rejected!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { settled = resolve; rejected = reject; });
  void closed.catch(() => {});
  const close = () => {
    state.closing ??= (async () => { await state.application?.runtime.close(); })();
    void state.closing.then(settled, rejected);
    return state.closing;
  };
  registerTools(server, () => {
    if (state.closing) throw new WorkspaceFailure('clientClosed');
    state.application ??= compose(config, configurationPath); return state.application.client;
  }, config.defaultMaxOutputBytes, config.tools);
  server.server.onclose = () => { void close().catch(rejected); };
  return { server, close, closed };
}

export function serveMipmuxStdio(config: HostConfig, configurationPath: string | null = null) {
  const instances = new Set<ReturnType<typeof createMcpServer>>();
  const outputCancelled = new Error('mcpOutputCancelled');
  let outputFailed = false;
  const output = new Writable({ write(bytes: Buffer, encoding, callback) {
    process.stdout.write(bytes, encoding, callback);
  } });
  const outputError = (error: Error) => { output.destroy(error); };
  process.stdout.on('error', outputError);
  output.on('error', error => { if (error !== outputCancelled) outputFailed = true; });
  output.once('close', () => process.stdout.off('error', outputError));
  const outputClosed = finished(output).catch((error: unknown) => {
    if (error !== outputCancelled) throw error;
  });
  void outputClosed.catch(() => {});
  const wire = new StdioServerTransport(process.stdin, output);
  const pending = new Set<Promise<void>>();
  const send = wire.send.bind(wire);
  wire.send = message => {
    const work = send(message);
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  const closeWire = wire.close.bind(wire);
  let wireClosing: Promise<void> | null = null;
  wire.close = () => wireClosing ??= closeWire();
  let closing: Promise<void> | null = null;
  let transportFailed = false;
  const transport = serveStdio(() => {
    const instance = createMcpServer(config, configurationPath); instances.add(instance); return instance.server;
  }, { transport: wire, onerror: error => {
    if (error === outputCancelled) return;
    if (closing) transportFailed = true;
    process.stderr.write('{"level":"error","event":"mcpTransportError"}\n');
  } });
  let settled!: () => void, rejected!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { settled = resolve; rejected = reject; });
  void closed.catch(() => {});
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const results = await Promise.allSettled([...instances].map(instance => instance.close()));
      output.destroy(outputCancelled);
      const writes = await Promise.allSettled([...pending]);
      for (const write of writes) {
        if (write.status === 'rejected' && write.reason !== outputCancelled) outputFailed = true;
      }
      results.push(...await Promise.allSettled([outputClosed]));
      results.push(...await Promise.allSettled([wire.close()]));
      results.push(...await Promise.allSettled([transport.close()]));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      if (transportFailed || outputFailed) throw new WorkspaceFailure('mcpTransportError');
    })();
    void closing.then(settled, rejected);
    return closing;
  };
  const transportClosed = wire.onclose;
  wire.onclose = () => { transportClosed?.(); void close().catch(rejected); };
  process.stdin.once('end', () => { void close().catch(rejected); });
  return { close, closed };
}
