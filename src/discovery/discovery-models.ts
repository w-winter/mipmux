import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelsStore } from '@earendil-works/pi-ai';
import { WorkspaceFailure } from '../workspace/values.js';
import { createCredentials, rejectCommands } from './pi-credentials.js';
import type { PiConfig } from './pi-protocol.js';

const closed = { additionalProperties: false };
const modelsValidator = Compile(Type.Object({ providers: Type.Record(Type.String(), Type.Object({
  baseUrl: Type.Optional(Type.String()),
  modelOverrides: Type.Optional(Type.Record(Type.String(), Type.Object({
    contextWindow: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    expectedServerModel: Type.Optional(Type.String({ minLength: 1 })),
  }, closed))),
}, closed)) }, closed));
/** The Pi API whose stream chunks name the model the server ran, and so the only one a served model can be declared for. */
const declarableApi = 'openai-completions';

interface ModelsStoreModule { FileModelsStore: new (path: string) => ModelsStore }
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parses a private SDK module with no exported import type.
function isModelsStoreModule(value: unknown): value is ModelsStoreModule {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Checks the constructor export at the SDK import boundary.
  return value !== null && typeof value === 'object' && 'FileModelsStore' in value && typeof value.FileModelsStore === 'function';
}

/** Pi's model runtime as discovery sees it, and the served models the models file declares. */
export interface DiscoveryModels {
  readonly runtime: ModelRuntime;
  /** The model ID the server is declared to report for this catalog model, or null when the models file declares none. */
  expectedServerModel(provider: string, model: string): string | null;
}

/**
 * Loads Pi's cached catalogs beside the auth file before applying model overrides. Catalog restoration is offline.
 * Read failures reject the operation. A served model can be declared only for the `openai-completions` API.
 */
export async function createDiscoveryModels(config: Pick<PiConfig, 'authPath' | 'modelsPath'>, signal: AbortSignal): Promise<DiscoveryModels> {
  const models: unknown = JSON.parse(await readFile(config.modelsPath, 'utf8'));
  const auth: unknown = JSON.parse(await readFile(config.authPath, 'utf8'));
  rejectCommands(models); rejectCommands(auth);
  if (!modelsValidator.Check(models)) throw new WorkspaceFailure('unsupportedModelConfiguration');
  const credentials = await createCredentials(config.authPath, signal);
  // Pi's file-backed catalog store is not exported by its package entry point.
  const sdk: unknown = await import(new URL('./core/models-store.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
  if (!isModelsStoreModule(sdk)) throw new WorkspaceFailure('unsupportedModelSDK');
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
    modelsStore: new sdk.FileModelsStore(join(dirname(config.authPath), 'models-store.json')),
    allowModelNetwork: false, refreshOnCreate: false, signal });
  const refreshed = await runtime.refresh({ allowNetwork: false, signal });
  signal.throwIfAborted();
  const failure = refreshed.errors.values().next().value;
  if (failure) throw failure instanceof WorkspaceFailure ? failure : new WorkspaceFailure('modelCatalogReadFailed');
  rejectCommands(runtime.getAllModels());
  // Keyed by `provider/model`; provider IDs contain no slash.
  const declared = new Map<string, string>();
  for (const [provider, data] of Object.entries(models.providers)) {
    if (!runtime.getProvider(provider)) throw new WorkspaceFailure('unsupportedModelConfiguration');
    runtime.registerProvider(provider, { models: runtime.getAllModels(provider).map(model => {
      const { expectedServerModel, ...overrides } = (model.type === 'chat' ? data.modelOverrides?.[model.id] : undefined) ?? {};
      if (expectedServerModel !== undefined) {
        if (model.api !== declarableApi) throw new WorkspaceFailure('unsupportedModelConfiguration');
        declared.set(`${provider}/${model.id}`, expectedServerModel);
      }
      return { ...model, ...overrides, baseUrl: data.baseUrl ?? model.baseUrl };
    }) });
  }
  if (runtime.getError()) throw new WorkspaceFailure('invalidModelConfiguration');
  return { runtime, expectedServerModel: (provider, model) => declared.get(`${provider}/${model}`) ?? null };
}

/** The `provider/model` references of the chat models discovery has credentials for, sorted. */
export async function listDiscoveryModels(config: Pick<PiConfig, 'authPath' | 'modelsPath'>, signal: AbortSignal): Promise<string[]> {
  const { runtime } = await createDiscoveryModels(config, signal);
  // In the worker's environment, Pi 1.5.0 answers availability per provider; asked for every provider at once, it returns an empty list.
  const available = await Promise.all(runtime.getProviders().map(provider => runtime.getAvailable(provider.id, { signal })));
  return available.flat().map(model => `${model.provider}/${model.id}`).sort();
}
