import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import type { MipmuxConfig } from './config.ts';
import type { EnhancementMode, ThinkingLevel } from './state.ts';

/*
 * The request defaults in mipmux's configuration file, which the panel edits and a running mipmux rereads before each
 * build. A save changes only the keys whose values changed, keeps the file's other keys, their order and its
 * indentation, and replaces the file only after `mipmux config` accepts the result.
 */
export interface DiscoveryDefaults { readonly model: string; readonly thinking: ThinkingLevel; readonly allowedModels: readonly string[] }
export interface ServerDefaults {
  readonly contextBudgetUnits: number;
  readonly defaultEnhancementMode: EnhancementMode;
  /** Null when the file configures no discovery. */
  readonly discovery: DiscoveryDefaults | null;
}
const JsonObject = Type.Record(Type.String(), Type.Unknown());
type JsonObject = Static<typeof JsonObject>;
const jsonObject = Compile(JsonObject);

export function serverDefaults(config: MipmuxConfig): ServerDefaults {
  return { contextBudgetUnits: config.contextBudgetUnits, defaultEnhancementMode: config.defaultEnhancementMode,
    discovery: config.discovery && { model: config.discovery.model, thinking: config.discovery.thinking, allowedModels: config.discovery.allowedModels } };
}

function parsedObject(text: string, path: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!jsonObject.Check(value)) throw new Error(`${path} does not hold a JSON object.`);
  return value;
}

/** The file's text with the keys whose values differ between `before` and `after` set to `after`'s values. */
export function editedText(text: string, path: string, before: ServerDefaults, after: ServerDefaults): string {
  const file = parsedObject(text, path);
  if (after.contextBudgetUnits !== before.contextBudgetUnits) file.contextBudgetUnits = after.contextBudgetUnits;
  if (after.defaultEnhancementMode !== before.defaultEnhancementMode) file.defaultEnhancementMode = after.defaultEnhancementMode;
  const discovery = file.discovery;
  if (after.discovery && before.discovery && jsonObject.Check(discovery)) {
    if (after.discovery.model !== before.discovery.model) {
      const slash = after.discovery.model.indexOf('/');
      discovery.provider = after.discovery.model.slice(0, slash);
      discovery.model = after.discovery.model.slice(slash + 1);
    }
    if (after.discovery.thinking !== before.discovery.thinking) discovery.thinking = after.discovery.thinking;
    if (JSON.stringify(after.discovery.allowedModels) !== JSON.stringify(before.discovery.allowedModels)) {
      discovery.allowedModels = [...after.discovery.allowedModels];
    }
  }
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  return JSON.stringify(file, null, indent) + (text.endsWith('\n') ? '\n' : '');
}

/**
 * Writes `after` into the configuration file at `path`, which held `read` when the panel opened. Fails, writing nothing,
 * when the file changed since, or when `validate` rejects the edited file, which it receives under a temporary name in the
 * same folder.
 */
export async function writeServerDefaults(path: string, read: string, before: ServerDefaults, after: ServerDefaults,
  validate: (path: string) => Promise<void>): Promise<void> {
  if (await readFile(path, 'utf8') !== read) throw new Error(`${path} changed while the panel was open; close the panel and open it again.`);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}`);
  await writeFile(temporary, editedText(read, path, before, after), { mode: 0o600 });
  try { await validate(temporary); }
  catch (error) {
    await unlink(temporary);
    throw error;
  }
  await rename(temporary, path);
}
