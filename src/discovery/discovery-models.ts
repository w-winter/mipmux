import { readFile } from 'node:fs/promises';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { WorkspaceFailure } from '../workspace/values.js';
import { createCredentials, rejectCommands } from './pi-credentials.js';
import type { PiConfig } from './pi-protocol.js';

const closed = { additionalProperties: false };
const modelsValidator = Compile(Type.Object({ providers: Type.Record(Type.String(), Type.Object({
  baseUrl: Type.Optional(Type.String()),
  modelOverrides: Type.Optional(Type.Record(Type.String(), Type.Object({
    contextWindow: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  }, closed))),
}, closed)) }, closed));

/**
 * Pi's model runtime as discovery sees it: the built-in providers of mipmux's Pi SDK, the models file's overrides and the
 * credentials in the auth file. It reads no models catalog from the network and loads no Pi extensions.
 */
export async function createDiscoveryModels(config: Pick<PiConfig, 'authPath' | 'modelsPath'>, signal: AbortSignal): Promise<ModelRuntime> {
  const models: unknown = JSON.parse(await readFile(config.modelsPath, 'utf8'));
  const auth: unknown = JSON.parse(await readFile(config.authPath, 'utf8'));
  rejectCommands(models); rejectCommands(auth);
  if (!modelsValidator.Check(models)) throw new WorkspaceFailure('unsupportedModelConfiguration');
  const credentials = await createCredentials(config.authPath, signal);
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false, signal });
  for (const [provider, data] of Object.entries(models.providers)) {
    if (!runtime.getProvider(provider)) throw new WorkspaceFailure('unsupportedModelConfiguration');
    runtime.registerProvider(provider, { models: runtime.getAllModels(provider).map(model => {
      const overrides = model.type === 'chat' ? data.modelOverrides?.[model.id] : undefined;
      return { ...model, ...overrides, baseUrl: data.baseUrl ?? model.baseUrl };
    }) });
  }
  if (runtime.getError()) throw new WorkspaceFailure('invalidModelConfiguration');
  return runtime;
}

/** The `provider/model` references of the chat models discovery has credentials for, sorted. */
export async function listDiscoveryModels(config: Pick<PiConfig, 'authPath' | 'modelsPath'>, signal: AbortSignal): Promise<string[]> {
  const runtime = await createDiscoveryModels(config, signal);
  // In the worker's environment, Pi 1.5.0 answers availability per provider; asked for every provider at once, it returns an empty list.
  const available = await Promise.all(runtime.getProviders().map(provider => runtime.getAvailable(provider.id, { signal })));
  return available.flat().map(model => `${model.provider}/${model.id}`).sort();
}
