import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { ThinkingLevel, type DiscoverySelection } from '../contracts/discovery.js';
import { PiConfig } from './pi-protocol.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';

const closed = { additionalProperties: false };
export const ModelChoice = Type.Object({ provider: PiConfig.properties.provider, model: PiConfig.properties.model }, closed);
export type ModelChoice = Static<typeof ModelChoice>;
/**
 * Resolved discovery settings: the worker configuration and the models a build request may select besides the configured
 * one, which is always allowed.
 */
export const DiscoveryHostConfig = Type.Object({ ...PiConfig.properties, allowedModels: Type.Array(ModelChoice) }, closed);
export type DiscoveryHostConfig = Static<typeof DiscoveryHostConfig>;
/** The configured model and level, and the other models a request may select; a host may replace them while running. */
export interface DiscoveryDefaults extends Pick<DiscoveryHostConfig, 'provider' | 'model' | 'thinking'> {
  readonly allowedModels: readonly ModelChoice[];
}
const defaultsValidator = Compile(Type.Object({ provider: ModelChoice.properties.provider, model: ModelChoice.properties.model,
  thinking: ThinkingLevel, allowedModels: Type.Array(ModelChoice) }, closed));
/** A frozen copy of `defaults`, or invalidDiscoveryConfiguration when they are not valid defaults. */
export function checkedDefaults(defaults: DiscoveryDefaults): DiscoveryDefaults {
  const copy = structuredClone({ provider: defaults.provider, model: defaults.model, thinking: defaults.thinking, allowedModels: defaults.allowedModels });
  if (!defaultsValidator.Check(copy)) throw new WorkspaceFailure('invalidDiscoveryConfiguration');
  return freeze(copy);
}
/** The model and thinking level one discovery job runs with. */
export interface DiscoverySettings { readonly provider: string; readonly model: string; readonly thinking: ThinkingLevel }

/** Splits a `provider/model` reference that `ModelReference` admitted at its first `/`. */
export function parseModelReference(reference: string): ModelChoice {
  const slash = reference.indexOf('/');
  return { provider: reference.slice(0, slash), model: reference.slice(slash + 1) };
}

export function modelReference(choice: ModelChoice): string { return choice.provider + '/' + choice.model; }

/**
 * The settings a build runs with: the configured model and level, with the selection's model and level in their place.
 * A selected model must be the configured one or an allowed one, or the build fails with modelNotAllowed. Whether the
 * model supports the level is checked when the worker resolves the model.
 */
export function selectDiscovery(config: DiscoveryDefaults, selection: DiscoverySelection | undefined): DiscoverySettings {
  const configured = { provider: config.provider, model: config.model }, allowed = [configured, ...config.allowedModels];
  const chosen = selection?.model === undefined ? configured : parseModelReference(selection.model);
  if (!allowed.some(choice => choice.provider === chosen.provider && choice.model === chosen.model)) {
    const references = allowed.map(modelReference);
    throw new WorkspaceFailure('modelNotAllowed', { message: `${modelReference(chosen)} is not an allowed discovery model; ` +
      `the allowed models are ${references.join(', ')}.` });
  }
  return { provider: chosen.provider, model: chosen.model, thinking: selection?.thinking ?? config.thinking };
}
