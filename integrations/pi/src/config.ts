import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { EnhancementMode, ModelReference, ThinkingLevel } from './state.ts';

/** The global defaults `mipmux config` prints: what a build uses for every setting no request or preference names. */
const MipmuxConfig = Type.Object({ kind: Type.Literal('config'), path: Type.String(), contextBudgetUnits: Type.Integer({ minimum: 1 }),
  defaultEnhancementMode: EnhancementMode, tools: Type.Enum(['core', 'full']),
  discovery: Type.Union([Type.Null(), Type.Object({ model: ModelReference, thinking: ThinkingLevel, allowedModels: Type.Array(ModelReference) },
    { additionalProperties: false })]) }, { additionalProperties: false });
export type MipmuxConfig = Static<typeof MipmuxConfig>;
/** The mipmux commands the extension runs: `config` reports the file at `path`, or the default file, and fails when mipmux rejects it. */
export interface MipmuxCommands {
  config(path?: string): Promise<MipmuxConfig>;
  models(path: string): Promise<string[]>;
}
const configValidator = Compile(MipmuxConfig);

/**
 * Runs `mipmux config` from PATH, as an MCP client configured with `mipmux mcp` starts the server, so the defaults shown
 * are the ones a newly started server reads. Fails with mipmux's error code, or with the reason the command could not run.
 */
export async function readMipmuxConfig(path?: string): Promise<MipmuxConfig> {
  const value: unknown = JSON.parse(await mipmux(['config', ...(path === undefined ? [] : ['--config', path])]));
  if (!configValidator.Check(value)) throw new Error('mipmux config printed an unexpected result; update mipmux or pi-mipmux');
  return value;
}

/** Runs mipmux from PATH and returns its output; fails with mipmux's error report, or with the reason the command could not run. */
async function mipmux(args: readonly string[]): Promise<string> {
  try { return (await promisify(execFile)('mipmux', [...args])).stdout; }
  catch (error) {
    // mipmux reports its failures as JSON on stdout; a command that never ran reports through the error message.
    const stdout = error instanceof Error && 'stdout' in error ? String(error.stdout).trim() : '';
    throw new Error(`mipmux ${args[0]} failed: ${stdout || (error instanceof Error ? error.message : 'unknown error')}`, { cause: error });
  }
}

const ModelList = Compile(Type.Object({ kind: Type.Literal('models'), models: Type.Array(ModelReference) }, { additionalProperties: false }));

/** The discovery models mipmux can use with its configured credentials, from `mipmux models`. */
export async function readMipmuxModels(path: string): Promise<string[]> {
  const value: unknown = JSON.parse(await mipmux(['models', '--config', path]));
  if (!ModelList.Check(value)) throw new Error('mipmux models printed an unexpected result; update mipmux or pi-mipmux');
  return value.models;
}
