import { IgnoreSettings } from '../contracts/inventory.js';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import Type, { type Static, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { PiConfig } from '../discovery/pi-protocol.js';
import { SmipRuntime } from '../runtime/smip-runtime.js';
import { PiRunner } from '../discovery/pi-runner.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';
import { mcpProtectedPaths } from '../discovery/mcp-config.js';

const closed = { additionalProperties: false };
const absolute = Type.String({ pattern: '^/[^\\u0000]*$' });
const executable = Type.Object({ executable: absolute }, closed);
export const HostConfig = Type.Object({ ignoreSettings: Type.Optional(IgnoreSettings), cachePath: absolute, nativeExecutable: absolute,
  nativeEnvironment: Type.Record(Type.String(), Type.String()),
  terminationGraceMs: Type.Integer({ minimum: 0, maximum: 2147483647 }),
  credentialPaths: Type.Array(absolute), search: Type.Union([executable, Type.Null()]),
  git: Type.Union([executable, Type.Null()]), discovery: Type.Union([PiConfig, Type.Null()]),
  defaultMaxOutputBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  contextBudgetUnits: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, closed);
export type HostConfig = Static<typeof HostConfig>;
export const hostValidator = Compile(HostConfig);

export async function loadJSON<S extends TSchema>(path: string, schema: S): Promise<Static<S>> {
  if (!isAbsolute(path)) throw new WorkspaceFailure('absoluteConfigurationRequired');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path))); }
  catch { throw new WorkspaceFailure('configurationReadFailed'); }
  const validator = Compile(schema);
  if (!validator.Check(value)) throw new WorkspaceFailure('invalidConfiguration');
  return freeze(value);
}
export function compose(config: HostConfig, configurationPath: string | null) {
  const runtimeOptions = { cachePath: config.cachePath, nativeExecutable: config.nativeExecutable,
    contextBudgetUnits: config.contextBudgetUnits,
    nativeEnvironment: config.nativeEnvironment, terminationGraceMs: config.terminationGraceMs,
    credentialPaths: [...config.credentialPaths, ...(configurationPath === null ? [] : [configurationPath]),
      ...(config.discovery ? [config.discovery.authPath, config.discovery.modelsPath,
        ...(config.discovery.mcp ? mcpProtectedPaths(config.discovery.mcp) : [])] : [])],
  };
  if (config.search) Object.assign(runtimeOptions, { search: config.search });
  if (config.git) Object.assign(runtimeOptions, { git: config.git });
  if (config.ignoreSettings) Object.assign(runtimeOptions, { ignoreSettings: config.ignoreSettings });
  const runtime = new SmipRuntime(runtimeOptions);
  const runner = config.discovery ? new PiRunner(config.discovery, runtime.supervisor) : null;
  return { runtime, client: runtime.createClient(runner) };
}
