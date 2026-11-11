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
    expectedServerModel: Type.Optional(Type.String({ minLength: 1 })),
  }, closed))),
}, closed)) }, closed));
/** The Pi API whose stream chunks name the model the server ran, and so the only one a served model can be declared for. */
const declarableApi = 'openai-completions';

/** Pi's model runtime as discovery sees it, and the served models the models file declares. */
export interface DiscoveryModels {
  readonly runtime: ModelRuntime;
  /** The model ID the server is declared to report for this catalog model, or null when the models file declares none. */
  expectedServerModel(provider: string, model: string): string | null;
}

/**
 * Pi's model runtime as discovery sees it: the built-in providers of mipmux's Pi SDK, the models file's overrides and the
 * credentials in the auth file. It reads no models catalog from the network and loads no Pi extensions. A declared served
 * model stays out of Pi's model record; declaring one for a model of another API than `openai-completions` is rejected.
 */
export async function createDiscoveryModels(config: Pick<PiConfig, 'authPath' | 'modelsPath'>, signal: AbortSignal): Promise<DiscoveryModels> {
  const models: unknown = JSON.parse(await readFile(config.modelsPath, 'utf8'));
  const auth: unknown = JSON.parse(await readFile(config.authPath, 'utf8'));
  rejectCommands(models); rejectCommands(auth);
  if (!modelsValidator.Check(models)) throw new WorkspaceFailure('unsupportedModelConfiguration');
  const credentials = await createCredentials(config.authPath, signal);
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false, signal });
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
