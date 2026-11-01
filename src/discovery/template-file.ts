import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { SourceIdentity } from '../contracts/workspace.js';
import type { DiscoveryInput } from '../contracts/discovery.js';
import { prepareDiscoveryInput, type DiscoveryPromptRenderer } from '../context/discovery-input.js';
import { readRegularFile } from '../runtime/host-files.js';
import { sha256, WorkspaceFailure } from '../workspace/values.js';
import { admitMcpConfiguration, type AdmittedMcp, type McpReference } from './mcp-config.js';

const systemFileFailure = Compile(Type.Object({ code: Type.String() }));

async function readDiscoveryTemplate(path: string, signal: AbortSignal) {
  let bytes: Buffer;
  try { bytes = await readRegularFile(path, new WorkspaceFailure('nonRegularDiscoveryTemplate'), signal); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof WorkspaceFailure) throw error;
    if (systemFileFailure.Check(error)) {
      throw new WorkspaceFailure('discoveryTemplateReadFailed', { systemCode: error.code });
    }
    throw error;
  }
  try { return { bytes, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; }
  catch (cause) {
    const failure = new WorkspaceFailure('invalidDiscoveryTemplate', { kind: 'encoding' });
    failure.cause = cause;
    throw failure;
  }
}

function logTemplateRejection(error: WorkspaceFailure, path: string, identity: SourceIdentity | null) {
  const record = { level: 'error', event: 'discoveryTemplateRejected', code: error.code,
    templatePath: path, ...error.details };
  if (identity) Object.assign(record, { templateSHA256: identity.sha256 });
  process.stderr.write(JSON.stringify(record) + '\n');
}

/**
 * Reads the discovery template at `path` and renders both startup channels with the model's tool names, which carry
 * `toolPrefix`. Returns the template's identity and the rendered channels; a rejected template is logged with its path.
 */
export async function prepareDiscoveryRun(path: string, input: DiscoveryInput, codemode: boolean, toolPrefix: string,
  signal: AbortSignal, render: DiscoveryPromptRenderer) {
  let admitted: Awaited<ReturnType<typeof readDiscoveryTemplate>>;
  try { admitted = await readDiscoveryTemplate(path, signal); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof WorkspaceFailure) logTemplateRejection(error, path, null);
    throw error;
  }
  const templateIdentity = { sha256: sha256(admitted.bytes), byteCount: admitted.bytes.length };
  try { return { templateIdentity, prepared: await prepareDiscoveryInput(input, admitted.text, codemode, toolPrefix, signal, render) }; }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof WorkspaceFailure) logTemplateRejection(error, path, templateIdentity);
    throw error;
  }
}

/** Admits a run's external MCP configuration, or none without a reference; a rejected configuration is logged. */
export async function admitRunMcp(reference: McpReference | null, signal: AbortSignal): Promise<AdmittedMcp | null> {
  try { return reference ? await admitMcpConfiguration(reference, signal) : null; }
  catch (error) {
    if (error instanceof WorkspaceFailure) process.stderr.write(JSON.stringify({ level: 'error', event: 'mcpConfigurationRejected',
      code: error.code, ...error.details }) + '\n');
    throw error;
  }
}
