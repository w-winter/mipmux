import { IgnoreSettings } from '../contracts/inventory.js';
import { CopyContext } from '../contracts/presentation.js';
import { PromptEnhancementMode } from '../contracts/context.js';
import { RecoveryPolicy } from '../contracts/discovery.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Type, { type Static, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { PiConfig } from '../discovery/pi-protocol.js';
import { MipmuxRuntime } from '../runtime/mipmux-runtime.js';
import { PiRunner } from '../discovery/pi-runner.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';
import { mcpProtectedPaths } from '../discovery/mcp-config.js';

const closed = { additionalProperties: false };
const absolute = Type.String({ pattern: '^/[^\\u0000]*$' });
/** Git and, by default, the user's configuration from `HOME` and `XDG_CONFIG_HOME`, whose excludes file Git applies. */
const GitHost = Type.Object({ executable: absolute, userConfiguration: Type.Optional(Type.Object({ home: absolute,
  xdgConfigHome: Type.Union([absolute, Type.Null()]) }, closed)) }, closed);
/** Resolved host settings with every path, policy and limit explicit. Library hosts construct this form directly. */
export const HostConfig = Type.Object({ copyContext: CopyContext, ignoreSettings: Type.Optional(IgnoreSettings), cachePath: absolute, nativeExecutable: absolute,
  nativeEnvironment: Type.Record(Type.String(), Type.String()),
  terminationGraceMs: Type.Integer({ minimum: 0, maximum: 2147483647 }),
  credentialPaths: Type.Array(absolute),
  git: Type.Union([GitHost, Type.Null()]), discovery: Type.Union([PiConfig, Type.Null()]),
  defaultMaxOutputBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  contextBudgetUnits: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  defaultEnhancementMode: Type.Optional(PromptEnhancementMode),
}, closed);
export type HostConfig = Static<typeof HostConfig>;
export const hostValidator = Compile(HostConfig);

const retry = RecoveryPolicy.properties.retry;
/** Discovery recovery overrides; each omitted field takes Pi's default. Cache warming is always off because it is billed. */
const PolicyFile = Type.Object({
  retry: Type.Optional(Type.Object({ ...Type.Partial(Type.Omit(retry, ['provider'])).properties,
    provider: Type.Optional(Type.Partial(retry.properties.provider, closed)) }, closed)),
  compaction: Type.Optional(Type.Partial(RecoveryPolicy.properties.compaction, closed)),
  transport: Type.Optional(RecoveryPolicy.properties.transport),
  httpIdleTimeoutMs: Type.Optional(RecoveryPolicy.properties.httpIdleTimeoutMs),
  websocketConnectTimeoutMs: Type.Optional(RecoveryPolicy.properties.websocketConnectTimeoutMs),
  cacheWarming: Type.Optional(RecoveryPolicy.properties.cacheWarming),
}, closed);
const DiscoveryFile = Type.Object({ ...Type.Partial(Type.Omit(PiConfig, ['provider', 'model', 'thinking', 'modelsPath', 'policy'])).properties,
  ...Type.Pick(PiConfig, ['provider', 'model', 'thinking', 'modelsPath']).properties, policy: Type.Optional(PolicyFile) }, closed);
/** The configuration file. Every field is optional; resolveHostConfig supplies each default. */
export const ConfigFile = Type.Object({ ...Type.Partial(Type.Omit(HostConfig, ['discovery'])).properties,
  discovery: Type.Optional(Type.Union([DiscoveryFile, Type.Null()])) }, closed);
export type ConfigFile = Static<typeof ConfigFile>;

/** Platform and process facts that select defaults. */
export interface ConfigHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Directory containing the package's `dist` and `libexec` directories. */
  readonly packageRoot: string;
}
export function currentConfigHost(): ConfigHost {
  return { platform: process.platform, arch: process.arch, home: homedir(), env: process.env,
    packageRoot: fileURLToPath(new URL('../..', import.meta.url)) };
}
export function defaultConfigPath(host: ConfigHost): string {
  return join(host.env.XDG_CONFIG_HOME ?? join(host.home, '.config'), 'mipmux', 'config.json');
}

/** RPCE's default copy state: Auto file tree, automatic codemaps, no Git inclusion, customizations or custom presets. */
const defaultCopyContext: CopyContext = { current: { fileTreeMode: 'Auto', codeMapUsage: 'auto', gitInclusion: 'none' },
  customizations: { includeFiles: null, includeUserPrompt: null, includeFileTree: null, fileTreeMode: null, codeMapUsage: null, gitInclusion: null },
  codeMapsGloballyDisabled: false, activeGitRoot: null, presets: [] };
/** Pi 1.0.2 defaults for the settings in RecoveryPolicy; provider requests time out with the HTTP idle timeout. */
const piPolicyDefaults = {
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000, provider: { maxRetries: 0, maxRetryDelayMs: 60000 } },
  compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  transport: 'auto', httpIdleTimeoutMs: 300000, websocketConnectTimeoutMs: 15000,
} as const;
/** Keeps a default exploration reply below Pi's 50 KiB tool-output guard. */
const defaultMaxOutputBytes = 48000;
const defaultContextBudgetUnits = 200000;
const defaultTerminationGraceMs = 1000;
/** The system Git; a PATH lookup can resolve a user's wrapper script instead. */
const defaultGitExecutable = '/usr/bin/git';

/**
 * Resolves a configuration file into explicit host settings. Omitted values take these defaults: RPCE's default copy
 * state, the platform cache directory (`~/Library/Caches/mipmux` on macOS, otherwise `$XDG_CACHE_HOME/mipmux` or
 * `~/.cache/mipmux`), the package's own native executable, `/usr/bin/git` with the user's Git configuration, a 200000-unit
 * budget, 48000-byte exploration replies and a 1000 ms termination grace. Discovery takes Pi's `auth.json` from `$PI_CODING_AGENT_DIR` or `~/.pi/agent`,
 * the shipped discovery template, codemode and Pi's recovery defaults, merged field by field with the file's overrides.
 */
export function resolveHostConfig(file: ConfigFile, host: ConfigHost): HostConfig {
  const cacheRoot = host.platform === 'darwin' ? join(host.home, 'Library', 'Caches') : host.env.XDG_CACHE_HOME ?? join(host.home, '.cache');
  const config: HostConfig = {
    copyContext: file.copyContext ?? defaultCopyContext,
    cachePath: file.cachePath ?? join(cacheRoot, 'mipmux'),
    nativeExecutable: file.nativeExecutable ?? join(host.packageRoot, 'libexec', `${host.platform}-${host.arch}`, 'MipmuxBridge'),
    nativeEnvironment: file.nativeEnvironment ?? {},
    terminationGraceMs: file.terminationGraceMs ?? defaultTerminationGraceMs,
    credentialPaths: file.credentialPaths ?? [],
    git: file.git === null ? null : { executable: file.git?.executable ?? defaultGitExecutable,
      userConfiguration: file.git?.userConfiguration ?? userGitConfiguration(host) },
    discovery: file.discovery ? resolveDiscovery(file.discovery, host) : null,
    defaultMaxOutputBytes: file.defaultMaxOutputBytes ?? defaultMaxOutputBytes,
    contextBudgetUnits: file.contextBudgetUnits ?? defaultContextBudgetUnits,
  };
  if (file.ignoreSettings !== undefined) config.ignoreSettings = file.ignoreSettings;
  if (file.defaultEnhancementMode !== undefined) config.defaultEnhancementMode = file.defaultEnhancementMode;
  return config;
}

/** Where Git finds the user's configuration; Git, like the XDG specification, ignores an empty or relative `XDG_CONFIG_HOME`. */
function userGitConfiguration(host: ConfigHost) {
  const xdgConfigHome = host.env.XDG_CONFIG_HOME;
  return { home: host.home, xdgConfigHome: xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : null };
}

function resolveDiscovery(file: Static<typeof DiscoveryFile>, host: ConfigHost): PiConfig {
  const policy = file.policy ?? {}, httpIdleTimeoutMs = policy.httpIdleTimeoutMs ?? piPolicyDefaults.httpIdleTimeoutMs;
  return {
    provider: file.provider, model: file.model, thinking: file.thinking, modelsPath: file.modelsPath,
    authPath: file.authPath ?? join(host.env.PI_CODING_AGENT_DIR ?? join(host.home, '.pi', 'agent'), 'auth.json'),
    promptTemplatePath: file.promptTemplatePath ?? join(host.packageRoot, 'dist', 'prompts', 'discovery.md'),
    environment: file.environment ?? {},
    mcp: file.mcp ?? null,
    codemode: file.codemode ?? true,
    policy: {
      retry: { ...piPolicyDefaults.retry, ...policy.retry,
        provider: { timeoutMs: httpIdleTimeoutMs, ...piPolicyDefaults.retry.provider, ...policy.retry?.provider } },
      compaction: { ...piPolicyDefaults.compaction, ...policy.compaction },
      transport: policy.transport ?? piPolicyDefaults.transport,
      httpIdleTimeoutMs,
      websocketConnectTimeoutMs: policy.websocketConnectTimeoutMs ?? piPolicyDefaults.websocketConnectTimeoutMs,
      cacheWarming: 'off',
    },
  };
}

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
  const runtimeOptions = { copyContext: config.copyContext, cachePath: config.cachePath, nativeExecutable: config.nativeExecutable,
    contextBudgetUnits: config.contextBudgetUnits,
    nativeEnvironment: config.nativeEnvironment, terminationGraceMs: config.terminationGraceMs,
    credentialPaths: [...config.credentialPaths, ...(configurationPath === null ? [] : [configurationPath]),
      ...(config.discovery ? [config.discovery.authPath, config.discovery.modelsPath,
        ...(config.discovery.mcp ? mcpProtectedPaths(config.discovery.mcp) : [])] : [])],
  };
  if (config.git) Object.assign(runtimeOptions, { git: config.git });
  if (config.ignoreSettings) Object.assign(runtimeOptions, { ignoreSettings: config.ignoreSettings });
  if (config.defaultEnhancementMode !== undefined) Object.assign(runtimeOptions, { defaultEnhancementMode: config.defaultEnhancementMode });
  const runtime = new MipmuxRuntime(runtimeOptions);
  const runner = config.discovery ? new PiRunner(config.discovery, runtime.supervisor,
    (operation, signal) => runtime.renderPresentation(operation, signal)) : null;
  return { runtime, client: runtime.createClient(runner) };
}
