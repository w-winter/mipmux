import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { SHA256 } from '../contracts/workspace.js';
import { readRegularFile } from '../runtime/host-files.js';
import { freeze, sha256, WorkspaceFailure } from '../workspace/values.js';

const closed = { additionalProperties: false };
export const McpReference = Type.Object({ agentDirectory: Type.String({ pattern: '^/[^\\u0000]*$' }) }, closed);
export type McpReference = Static<typeof McpReference>;
const oauth = Type.Object({
  clientId: Type.Optional(Type.String()), clientSecret: Type.Optional(Type.String()),
  callbackPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })), callbackUrl: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()), clientName: Type.Optional(Type.String()),
  clientRegistration: Type.Optional(Type.Enum(['dcr', 'cimd'])), authServerMetadataUrl: Type.Optional(Type.String()),
}, closed);
const server = Type.Object({ type: Type.Optional(Type.Literal('http')), url: Type.String(),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), closed)), oauth: Type.Optional(oauth),
  description: Type.Optional(Type.String()), timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  exposure: Type.Literal('hidden'), toolExposure: Type.Record(Type.String({ minLength: 1, pattern: '^[^*]+$' }), Type.Literal('direct'), { ...closed, minProperties: 1 }),
}, closed);
const configuration = Type.Object({ mcpServers: Type.Record(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_]*$' }), server, { ...closed, minProperties: 1 }) }, closed);
export const AdmittedMcp = Type.Object({ reference: McpReference, configSHA256: SHA256, configuration }, closed);
export type AdmittedMcp = Static<typeof AdmittedMcp>;
const validator = Compile(configuration);

function literal(value: string): boolean {
  if (value.startsWith('!')) return false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '$') continue;
    const next = value[index + 1];
    if (next === '$' || next === '!') { index++; continue; }
    if (/^[A-Za-z_]/.test(value.slice(index + 1)) || /^\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value.slice(index + 1))) return false;
  }
  return true;
}

function admitServerValues(name: string, config: Static<typeof server>): void {
  let url: URL;
  try { url = new URL(config.url); }
  catch (cause) { throw Object.defineProperty(new WorkspaceFailure('invalidMcpConfiguration', { server: name, field: 'url' }), 'cause', { value: cause }); }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new WorkspaceFailure('invalidMcpConfiguration', { server: name, field: 'url' });
  }
  for (const [header, text] of Object.entries(config.headers ?? {})) {
    if (!literal(text)) throw new WorkspaceFailure('nonLiteralMcpValue', { server: name, field: 'headers' });
    try { new Headers([[header, text]]); }
    catch (cause) { throw Object.defineProperty(new WorkspaceFailure('invalidMcpConfiguration', { server: name, field: 'headers' }), 'cause', { value: cause }); }
  }
  if (config.oauth?.clientSecret !== undefined && !literal(config.oauth.clientSecret)) {
    throw new WorkspaceFailure('nonLiteralMcpValue', { server: name, field: 'oauth.clientSecret' });
  }
}

/** Admits a private HTTP-only policy per job; native semantic validation also runs in the worker. */
export async function admitMcpConfiguration(reference: McpReference, signal: AbortSignal): Promise<AdmittedMcp> {
  signal.throwIfAborted();
  let bytes: Buffer;
  try {
    const directory = await stat(reference.agentDirectory);
    if (!directory.isDirectory()) throw new WorkspaceFailure('invalidMcpConfiguration', { field: 'agentDirectory' });
    if ((directory.mode & 0o077) !== 0) throw new WorkspaceFailure('mcpDirectoryNotPrivate');
    bytes = await readRegularFile(join(reference.agentDirectory, 'mcp.json'), new WorkspaceFailure('nonRegularMcpConfiguration'), signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WorkspaceFailure) throw error;
    throw Object.defineProperty(new WorkspaceFailure('unreadableMcpConfiguration'), 'cause', { value: error });
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch (cause) { throw Object.defineProperty(new WorkspaceFailure('invalidMcpConfiguration', { field: '$' }), 'cause', { value: cause }); }
  if (!validator.Check(value)) throw new WorkspaceFailure('invalidMcpConfiguration', { field: validator.Errors(value)[0]?.instancePath });
  for (const [name, config] of Object.entries(value.mcpServers)) admitServerValues(name, config);
  signal.throwIfAborted();
  return freeze({ reference, configSHA256: sha256(bytes), configuration: value });
}

export function mcpProtectedPaths(reference: McpReference): string[] {
  return [reference.agentDirectory, join(reference.agentDirectory, 'mcp.json'), join(reference.agentDirectory, 'mcp-auth.json')];
}
