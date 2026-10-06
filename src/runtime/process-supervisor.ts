import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface ProcessSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export interface ProcessReceipt {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError: Error | null;
}

export interface OwnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves only after the child's close event, including failed spawn. */
  readonly closed: Promise<ProcessReceipt>;
  /** Requests termination, escalates after the configured grace, and joins close. */
  stop(): Promise<ProcessReceipt>;
}

export class ProcessSupervisor {
  readonly #grace: number;
  readonly #processes = new Set<OwnedProcess>();
  #closing: Promise<void> | null = null;

  constructor(options: { readonly terminationGraceMs: number }) {
    const maximumNodeTimerDelayMs = 2_147_483_647;
    if (!Number.isSafeInteger(options.terminationGraceMs) || options.terminationGraceMs < 0 || options.terminationGraceMs > maximumNodeTimerDelayMs) {
      throw new Error('terminationGraceMs must fit the nonnegative Node timer range');
    }
    this.#grace = options.terminationGraceMs;
  }

  spawn(spec: ProcessSpec): OwnedProcess {
    if (this.#closing) throw new Error('Process supervisor is closed');
    const id = randomUUID();
    const child = spawn(spec.executable, [...spec.args], { cwd: spec.cwd, env: spec.env, shell: false, stdio: 'pipe' });
    let spawnError: Error | null = null;
    let closed = false;
    let stopping: Promise<ProcessReceipt> | null = null;
    child.on('error', error => { spawnError = error; });
    child.stderr.on('data', () => {});
    const completion = new Promise<ProcessReceipt>(resolve => {
      child.once('close', (code, signal) => {
        closed = true;
        process.stderr.write(JSON.stringify({ level: 'info', event: 'processClosed', id, code, signal }) + '\n');
        resolve({ code, signal, spawnError });
      });
    });
    const owned: OwnedProcess = {
      child,
      closed: completion,
      stop: () => {
        if (stopping) return stopping;
        stopping = (async () => {
          if (closed) return completion;
          child.kill('SIGTERM');
          const timer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, this.#grace);
          try { return await completion; } finally { clearTimeout(timer); }
        })();
        return stopping;
      },
    };
    this.#processes.add(owned);
    void completion.then(() => { this.#processes.delete(owned); });
    process.stderr.write(JSON.stringify({ level: 'info', event: 'processSpawned', id }) + '\n');
    return owned;
  }

  close(): Promise<void> {
    this.#closing ??= Promise.all([...this.#processes].map(child => child.stop())).then(() => {});
    return this.#closing;
  }
}
