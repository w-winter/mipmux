#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import Type from 'typebox';
import { ContextBuildRequest, SourceSelection } from '../contracts/context.js';
import { WorkspaceSpec } from '../contracts/inventory.js';
import { gitValidator } from '../contracts/git.js';
import { readValidator, treeValidator, searchValidator, structureValidator } from '../contracts/exploration.js';
import { verifyBundle, verifyCurrentBundle } from '../context/verify.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { failureCode, failureResult } from '../runtime/tool-result.js';
import { HostConfig, compose, loadJSON } from './config.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';

const closed = { additionalProperties: false };
const RenderInput = Type.Object({ workspace: WorkspaceSpec, request: ContextBuildRequest }, closed);
const BuildInput = Type.Object({ workspace: WorkspaceSpec, request: ContextBuildRequest, requestId: Type.String({ minLength: 1 }) }, closed);
const DraftInput = Type.Object({ selections: Type.Array(SourceSelection), prompt: Type.String() }, closed);
const maximumNodeTimerDelayMs = 2147483647;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, spec: { type: 'string' }, workspace: { type: 'string' }, input: { type: 'string' },
    request: { type: 'string' }, draft: { type: 'string' }, bundle: { type: 'string' }, mode: { type: 'string' }, key: { type: 'string' }, kind: { type: 'string' },
  } });
  const [command, subcommand] = positionals;
  function required(name: keyof typeof values): string {
    const value = values[name]; if (!value) throw new WorkspaceFailure('missingArgument'); return value;
  }
  function shape(flags: readonly string[], positionalCount: number) {
    if (positionals.length !== positionalCount || Object.keys(values).some(key => !flags.includes(key))) throw new WorkspaceFailure('invalidArguments');
  }
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    if (command === 'verify' && values.mode === 'integrity') {
      shape(['bundle', 'mode'], 1);
      const directory = required('bundle'); if (!isAbsolute(directory)) throw new WorkspaceFailure('absoluteConfigurationRequired');
      process.stdout.write(JSON.stringify(await verifyBundle(directory)) + '\n'); return;
    }
    const path = required('config'), config = await loadJSON(path, HostConfig);
    if (command === 'mcp') {
      shape(['config'], 1);
      const { serveSmipStdio } = await import('../mcp/server.js');
      const server = serveSmipStdio(config, path);
      const stop = () => { void server.close().catch(() => {}); };
      abort.signal.addEventListener('abort', stop, { once: true });
      if (abort.signal.aborted) stop();
      try { await server.closed; }
      finally { abort.signal.removeEventListener('abort', stop); }
      return;
    }
    const { runtime, client } = compose(config, path);
    let result: unknown;
    try {
      switch (command) {
        case 'workspace': {
          shape(['spec', 'config'], 1);
          const workspace = await client.declare(await loadJSON(required('spec'), WorkspaceSpec), abort.signal);
          result = await client.refresh(workspace.id, abort.signal); break;
        }
        case 'tool': {
          shape(['workspace', 'input', 'config'], 2);
          const raw = await loadJSON(required('input'), Type.Unknown());
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new WorkspaceFailure('invalidRequest');
          const input = { maxOutputBytes: config.defaultMaxOutputBytes, ...raw };
          let execute: (operation: WorkspaceOperation) => unknown | Promise<unknown>;
          if (subcommand === 'git') {
            const request = gitValidator.Default(input);
            if (!gitValidator.Check(request)) throw new WorkspaceFailure('invalidRequest');
            execute = operation => operation.readGit(request);
          }
          else if (subcommand === 'read_file' && readValidator.Check(input)) execute = operation => operation.readFile(input);
          else if (subcommand === 'get_file_tree' && treeValidator.Check(input)) execute = operation => operation.getFileTree(input);
          else if (subcommand === 'get_code_structure' && structureValidator.Check(input)) execute = operation => operation.getCodeStructure(input);
          else if (subcommand === 'file_search' && searchValidator.Check(input)) execute = operation => operation.fileSearch(input);
          else throw new WorkspaceFailure('invalidRequest');
          const workspace = await runtime.declare(await loadJSON(required('workspace'), WorkspaceSpec), abort.signal);
          const operation = await workspace.openOperation(abort.signal);
          try {
            result = await execute(operation);
            if (typeof result === 'object' && result !== null && 'kind' in result &&
                (result.kind === 'outputBudgetTooSmall' || result.kind === 'recordTooLarge')) process.exitCode = 1;
          } finally { await operation.close(); await workspace.close(); }
          break;
        }
        case 'build': {
          shape(['request', 'config'], 1);
          const input = await loadJSON(required('request'), BuildInput);
          const workspace = await client.declare(input.workspace, abort.signal);
          const job = client.build(workspace.id, input.requestId, input.request);
          const cancel = () => { client.cancel(job.jobId); };
          abort.signal.addEventListener('abort', cancel, { once: true });
          if (abort.signal.aborted) cancel();
          try {
            let snapshot = client.result(job.jobId);
            while (!snapshot.localSettled) snapshot = await client.wait(job.jobId, maximumNodeTimerDelayMs,
              new AbortController().signal, progress => process.stderr.write(JSON.stringify({ event: 'progress', jobId: progress.jobId,
                sequence: progress.sequence, state: progress.state }) + '\n'));
            result = snapshot;
            process.exitCode = snapshot.state === 'ready' ? 0 : snapshot.state === 'blocked' ? 2 : snapshot.state === 'cancelled' ? 130 : 1;
          } finally { abort.signal.removeEventListener('abort', cancel); }
          break;
        }
        case 'render': {
          shape(['request', 'draft', 'config'], 1);
          const input = await loadJSON(required('request'), RenderInput), selection = await loadJSON(required('draft'), DraftInput);
          const workspace = await client.declare(input.workspace, abort.signal);
          const draft = await client.createDraft(workspace.id, input.request, abort.signal);
          let revision = draft.revision;
          for (const item of selection.selections) {
            revision = (await client.update(draft.id, { expectedRevision: revision, maxOutputBytes: config.defaultMaxOutputBytes,
              mutation: { kind: 'upsert', selection: item } }, abort.signal)).revision;
          }
          await client.update(draft.id, { expectedRevision: revision, maxOutputBytes: config.defaultMaxOutputBytes,
            mutation: { kind: 'prompt', op: 'set', text: selection.prompt } }, abort.signal);
          const finalized = await client.finalize(draft.id, abort.signal); result = finalized;
          if (finalized.kind !== 'ready') process.exitCode = 2;
          break;
        }
        case 'verify': {
          shape(['bundle', 'mode', 'config'], 1);
          if (values.mode !== 'current') throw new WorkspaceFailure('invalidArguments');
          const directory = required('bundle'); if (!isAbsolute(directory)) throw new WorkspaceFailure('absoluteConfigurationRequired');
          result = await verifyCurrentBundle(directory, runtime, abort.signal); break;
        }
        case 'cache': {
          shape(['kind', 'key', 'config'], 2);
          if (subcommand !== 'invalidate') throw new WorkspaceFailure('invalidArguments');
          const kind = required('kind'), key = required('key');
          if (kind === 'artifact') await runtime.artifacts.invalidate(key);
          else if (kind === 'membership') await runtime.artifacts.invalidateMembership(key);
          else throw new WorkspaceFailure('invalidArguments');
          result = { kind: 'invalidated', target: { kind, key } }; break;
        }
        default: throw new WorkspaceFailure('invalidCommand');
      }
    } finally { await runtime.close(); }
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}

void main().catch(error => {
  const code = failureCode(error);
  process.exitCode = code === 'cancelled' ? 130 : 1;
  const output = process.argv[2] === 'mcp' ? process.stderr : process.stdout;
  const failure = failureResult(error);
  output.write(JSON.stringify({ kind: 'failed', code, ...('target' in failure ? { target: failure.target } : {}) }) + '\n');
});
