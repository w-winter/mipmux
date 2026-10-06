import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { compose, hostValidator, type HostConfig } from '../cli/config.js';
import { registerTools } from './tools.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';

/** Factory construction validates structure only. Resources are admitted on the first tool call. */
export function createMcpServer(input: HostConfig, configurationPath: string | null = null) {
  if (!hostValidator.Check(input)) throw new WorkspaceFailure('invalidConfiguration');
  const config = freeze(structuredClone(input));
  const state: { application: ReturnType<typeof compose> | null; closing: Promise<void> | null } = { application: null, closing: null };
  const server = new McpServer({ name: 'smip', version: '0.1.0' });
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
  }, config.defaultMaxOutputBytes);
  server.server.onclose = () => { void close().catch(rejected); };
  return { server, close, closed };
}

export function serveSmipStdio(config: HostConfig, configurationPath: string | null = null) {
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
