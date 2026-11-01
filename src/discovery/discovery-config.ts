import Type, { type Static } from 'typebox';
import { WorkspaceFailure } from '../workspace/values.js';
import { PiConfig } from './pi-protocol.js';
import { ModelChoice, modelReference, type DiscoveryDefaults, type DiscoveryHostConfig } from './selection.js';

const closed = { additionalProperties: false };
const absolute = PiConfig.properties.promptTemplatePath;
/** The provider name of the models discovery runs through Claude Code, as in `claude-code/claude-sonnet-5-5`. */
export const claudeCodeProvider = 'claude-code';
/** The prefix Claude Code gives the tools of mipmux's in-process MCP server, which is named `mipmux`. */
export const mipmuxToolPrefix = 'mcp__mipmux__';
/**
 * How discovery starts Claude Code: the executable (null runs the Claude Agent SDK's bundled one), the complete environment
 * the child starts from, and Claude Code's own configuration and login paths, which context collection never reads.
 */
export const ClaudeCodeConfig = Type.Object({ executable: Type.Union([absolute, Type.Null()]),
  environment: Type.Record(Type.String(), Type.String()), configPaths: Type.Array(absolute) }, closed);
export type ClaudeCodeConfig = Static<typeof ClaudeCodeConfig>;
/** The settings only the Pi runner uses. */
const PiSettings = Type.Object({ modelsPath: absolute, authPath: absolute, environment: PiConfig.properties.environment,
  codemode: PiConfig.properties.codemode, policy: PiConfig.properties.policy }, closed);
/**
 * Resolved discovery settings: the configured model and level, the other models a request may select, the template and
 * external MCP servers every runner uses, and each runner's own settings. A runner's settings are present when the
 * configuration gives them, and must be when the configured or an allowed model runs through that runner.
 */
export const DiscoveryConfig = Type.Object({ provider: PiConfig.properties.provider, model: PiConfig.properties.model,
  thinking: PiConfig.properties.thinking, allowedModels: Type.Array(ModelChoice),
  promptTemplatePath: absolute, mcp: PiConfig.properties.mcp,
  pi: Type.Union([PiSettings, Type.Null()]), claudeCode: Type.Union([ClaudeCodeConfig, Type.Null()]) }, closed);
export type DiscoveryConfig = Static<typeof DiscoveryConfig>;

/** Which runners a host can start. */
export interface ConfiguredRunners { readonly pi: boolean; readonly claudeCode: boolean }

/** Fails with invalidDiscoveryConfiguration, naming the setting each needs, when the configured or an allowed model has no runner. */
export function checkRunnerCoverage(defaults: DiscoveryDefaults, runners: ConfiguredRunners): void {
  const missing = [defaults, ...defaults.allowedModels].flatMap(choice => {
    if (choice.provider === claudeCodeProvider) return runners.claudeCode ? [] : [`${modelReference(choice)} needs discovery.claudeCode`];
    return runners.pi ? [] : [`${modelReference(choice)} needs discovery.modelsPath`];
  });
  if (missing.length) throw new WorkspaceFailure('invalidDiscoveryConfiguration', { message: `${missing.join('; ')}.` });
}

/** The Pi runner's configuration, or null when the discovery settings configure no Pi runner. */
export function piRunnerConfig(config: DiscoveryConfig): DiscoveryHostConfig | null {
  const { pi, claudeCode: _claudeCode, ...shared } = config;
  return pi && { ...shared, ...pi };
}
