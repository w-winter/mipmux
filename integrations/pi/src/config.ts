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
const configValidator = Compile(MipmuxConfig);

/**
 * Runs `mipmux config` from PATH, as the user's MCP adapter starts `mipmux mcp`, so the defaults shown are the ones a
 * newly started server reads. Fails with mipmux's error code, or with the reason the command could not run.
 */
export async function readMipmuxConfig(): Promise<MipmuxConfig> {
  let output: string;
  try { output = (await promisify(execFile)('mipmux', ['config'])).stdout; }
  catch (error) {
    // mipmux reports its failures as JSON on stdout; a command that never ran reports through the error message.
    const stdout = error instanceof Error && 'stdout' in error ? String(error.stdout).trim() : '';
    throw new Error(`mipmux config failed: ${stdout || (error instanceof Error ? error.message : 'unknown error')}`, { cause: error });
  }
  const value: unknown = JSON.parse(output);
  if (!configValidator.Check(value)) throw new Error('mipmux config printed an unexpected result; update mipmux or pi-mipmux');
  return value;
}
