import { createHash, randomUUID } from 'node:crypto';
import { nativeFrameValidator, nativeRequestValidator, type NativeFrame, type NativeOperation, type NativeResult } from '../contracts/native.js';
import { ProcessSupervisor, type OwnedProcess, type ProcessReceipt } from '../runtime/process-supervisor.js';
import type { SourceIdentity } from '../contracts/workspace.js';
import type { NativeFailureCode } from '../contracts/errors.js';

type Entry = Extract<NativeFrame, { kind: 'entry' }>;
const resultKinds = {
  serializeGitSnapshot: ['gitSnapshotBytes'],
  electGitTarget: ['gitTarget'],
  revalidateGitTargets: ['gitTargetValidation'],
  captureIgnoreInputs: ['ignoreInputs'], queryIgnoreHierarchy: ['ignoreHierarchy'],
  queryIgnoreRules: ['ignoreRules'],
  parseGitPatch: ['gitPatch'], parseGitComparison: ['gitComparison'], projectGitDiff: ['gitDiff'],
  normalizeGitDiffPaths: ['gitDiffPaths'],
  prepareGitDiff: ['gitDiffArguments'], parseGitDiffStats: ['gitDiffStats'],
  normalizeGitUntrackedPatch: ['gitUntrackedPatch'],
  prepareGitShow: ['gitShowArguments', 'gitShowError'], parseGitShowMetadata: ['gitShowMetadata', 'gitShowError'], projectGitShow: ['gitShow'],
  describe: ['description'], openRoots: ['rootsOpened'], listDirectory: ['directoryComplete'],
  prepareGitRead: ['gitReadArguments'], projectGitRead: ['gitLog', 'gitBlame', 'gitStatus', 'gitStatusError'],
  sliceReadText: ['readTextSlice', 'readTextRangeError'],
  renderFileBlock: ['fileBlock'],
  readSource: ['sourceComplete'], extract: ['extracted', 'unsupportedExtension'],
  beginExport: ['exportOpened'], writeExport: ['exportWritten'], readExport: ['exportRead'],
  publishManifest: ['manifestPublished'],
  renderDiscoveryPrompt: ['discoveryPrompt'],
  renderDiscoveryMessage: ['discoveryMessage'],
  renderFileTree: ['fileTree'],
  renderPromptAssembly: ['promptAssembly'],
  renderClipboard: ['clipboard'],
  renderPreparedClipboard: ['preparedClipboard'],
  queryStructure: ['structure'],
  transitionSelection: ['selectionTransition'],
  calculateSliceRanges: ['sliceRanges'],
  matchSelectionPath: ['pathMatch'],
  resolveSelectionCandidates: ['selectionCandidates'],
  mutateSelectionPaths: ['selectionPathMutation'],
  prepareSelection: ['selectionBuilt', 'selectionSlicesChanged'],
  parseSelectionInputs: ['selectionInputs'],
  selectionPathBindings: ['selectionPathBindings'],
  selectionHint: ['selectionHint'],
  renderSelectionReply: ['selectionReply'],
} as const satisfies Record<NativeOperation['kind'], readonly NativeResult['kind'][]>;
type ResultByOperation = { [K in NativeOperation['kind']]: Extract<NativeResult, { kind: typeof resultKinds[K][number] }> };
export interface NativeReply<K extends NativeOperation['kind'] = NativeOperation['kind']> {
  readonly result: ResultByOperation[K];
  readonly bytes: Buffer;
  readonly entries: readonly Entry[];
}
interface Pending {
  readonly id: string;
  readonly operation: NativeOperation;
  readonly chunks: Buffer[];
  readonly entries: Entry[];
  terminal: NativeResult | null;
  readonly resolve: (value: NativeReply) => void;
  readonly reject: (error: Error) => void;
}

export class NativeFailure extends Error {
  constructor(readonly code: NativeFailureCode, readonly errno: number | null) { super(code); }
}

export class NativeWorkerFailure extends Error {
  readonly code = 'nativeWorkerFailed';
  constructor(readonly receipt: ProcessReceipt, readonly sourceIdentity: SourceIdentity | null) { super('nativeWorkerFailed'); }
}

export class BridgeClient {
  readonly #generation = randomUUID();
  readonly #process: OwnedProcess;
  #pending: Pending | null = null;
  #buffer = Buffer.alloc(0);
  #tail: Promise<void> = Promise.resolve();
  #retired: Promise<Error> | null = null;
  #stopping: Promise<ProcessReceipt> | null = null;

  constructor(options: { readonly executable: string; readonly supervisor: ProcessSupervisor; readonly env: Readonly<Record<string, string>> }) {
    this.#process = options.supervisor.spawn({ executable: options.executable, args: [this.#generation], env: options.env, cwd: '/' });
    this.#process.child.stdout.on('data', (bytes: Buffer) => this.#receive(bytes));
    this.#process.child.stdin.on('error', () => this.#workerFailed());
    void this.#process.closed.then(() => this.#workerFailed());
  }

  /** Serializes requests on this owned process. Aborting retires it and rejects queued work. */
  request<O extends NativeOperation>(operation: O, signal: AbortSignal): Promise<NativeReply<O['kind']>> {
    const snapshot = structuredClone(operation);
    const request = { wireVersion: 1, requestId: randomUUID(), generation: this.#generation, operation: snapshot };
    if (!nativeRequestValidator.Check(request)) return Promise.reject(new NativeFailure('invalidRequest', null));
    if ('bytes' in snapshot) {
      try { decodeBase64(snapshot.bytes); } catch { return Promise.reject(new NativeFailure('invalidRequest', null)); }
    }
    const abort = () => { this.#retire(new NativeFailure('cancelled', null)); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const result = this.#tail.then(async () => {
      if (this.#retired) {
        await this.#process.closed;
        throw await this.#retired;
      }
      try {
        return await new Promise<NativeReply>((resolve, reject) => {
          this.#pending = { id: request.requestId, operation: snapshot, chunks: [], entries: [], terminal: null, resolve, reject };
          this.#process.child.stdin.write(JSON.stringify(request) + '\n');
        });
      } catch (error) {
        if (this.#retired) {
          await this.#process.closed;
          throw await this.#retired;
        }
        throw error;
      }
    }).finally(() => signal.removeEventListener('abort', abort));
    this.#tail = result.then(() => {}, () => {});
    // #verify checks the operation/result mapping before resolving the internal reply.
    return result as Promise<NativeReply<O['kind']>>;
  }

  #receive(bytes: Buffer): void {
    if (this.#retired) return;
    if (bytes.length && !this.#pending) {
      this.#retire(new NativeFailure('nativeProtocolError', null));
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    try {
      let newline: number;
      while ((newline = this.#buffer.indexOf(0x0a)) !== -1) {
        const line = this.#buffer.subarray(0, newline);
        this.#buffer = this.#buffer.subarray(newline + 1);
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line));
        const pending = this.#pending;
        if (!nativeFrameValidator.Check(value) || !pending || pending.terminal ||
            value.generation !== this.#generation || value.requestId !== pending.id) {
          throw new NativeFailure('nativeProtocolError', null);
        }
        if (value.kind === 'bytes') {
          if (pending.operation.kind !== 'readSource') throw new NativeFailure('nativeProtocolError', null);
          pending.chunks.push(decodeBase64(value.bytes));
        } else if (value.kind === 'entry') {
          if (pending.operation.kind !== 'listDirectory') throw new NativeFailure('nativeProtocolError', null);
          pending.entries.push(value);
        } else {
          pending.terminal = value.result;
        }
      }
      const pending = this.#pending;
      if (pending?.terminal) {
        if (this.#buffer.length) throw new NativeFailure('nativeProtocolError', null);
        const result = pending.terminal;
        if (result.kind === 'failure') {
          this.#pending = null;
          pending.reject(new NativeFailure(result.code, result.errno));
          return;
        }
        const collected = Buffer.concat(pending.chunks);
        this.#verify(pending, result, collected);
        this.#pending = null;
        pending.resolve({ result, bytes: collected, entries: pending.entries });
      }
    } catch {
      this.#retire(new NativeFailure('nativeProtocolError', null));
    }
  }

  #verify(pending: Pending, result: NativeResult, bytes: Buffer): void {
    const kinds: readonly NativeResult['kind'][] = resultKinds[pending.operation.kind];
    if (!kinds.includes(result.kind)) throw new Error('wrong response kind');
    if (result.kind === 'sourceComplete') {
      if (result.identity.byteCount !== bytes.length || result.identity.sha256 !== sha256(bytes)) throw new Error('source identity mismatch');
      if (result.decoding.kind === 'decoded') {
        const text = Buffer.from(result.decoding.text);
        if (text.toString() !== result.decoding.text || text.length !== result.decoding.identity.byteCount ||
          sha256(text) !== result.decoding.identity.sha256) throw new Error('decoded source identity mismatch');
      }
    }
    if (result.kind === 'directoryComplete') {
      const canonical = pending.entries.map(entry => `${entry.entryKind}\0${entry.name}\0`).join('');
      if (result.count !== pending.entries.length || result.sha256 !== sha256(Buffer.from(canonical))) throw new Error('directory identity mismatch');
    }
    if (result.kind === 'extracted' || result.kind === 'sourceComplete') {
      if (result.key && sha256(decodeBase64(result.key.canonicalBase64)) !== result.key.digest) throw new Error('key digest mismatch');
      if (result.kind === 'extracted' && (result.outcome.kind === 'ready') !== (result.projection !== null)) throw new Error('projection mismatch');
    }
    if (result.kind === 'exportRead') {
      const content = decodeBase64(result.bytes);
      if (content.length !== result.identity.byteCount || sha256(content) !== result.identity.sha256) throw new Error('export identity mismatch');
    }
  }

  #workerFailed(): void {
    if (this.#retired) return;
    const operation = this.#pending?.operation;
    const source = operation?.kind === 'extract' || operation?.kind === 'readSource' ? operation.expected : null;
    this.#retire(this.#process.closed.then(receipt => new NativeWorkerFailure(receipt, source)), 'nativeWorkerFailed');
  }

  #retire(error: NativeFailure | Promise<NativeWorkerFailure>, code = error instanceof NativeFailure ? error.code : 'nativeWorkerFailed'): void {
    if (this.#retired) return;
    const intentional = code === 'cancelled' || code === 'nativeWorkerClosed';
    process.stderr.write(JSON.stringify({ level: intentional ? 'info' : 'error', event: 'nativeWorkerRetired',
      generation: this.#generation, operation: this.#pending?.operation.kind ?? null, code }) + '\n');
    this.#retired = Promise.resolve(error);
    const pending = this.#pending;
    void this.#retired.then(failure => pending?.reject(failure));
    this.#pending = null;
    this.#buffer = Buffer.alloc(0);
    this.#stopping = this.#process.stop();
    void this.#stopping.catch(() => {});
  }

  async close(): Promise<void> {
    this.#retire(new NativeFailure('nativeWorkerClosed', null));
    await this.#process.closed;
    await this.#tail;
    await this.#stopping;
  }

  get retired(): boolean { return this.#retired !== null; }
  get closed(): Promise<ProcessReceipt> { return this.#process.closed; }
}

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function decodeBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('noncanonical base64');
  return bytes;
}
