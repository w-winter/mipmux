import { IgnoreSettings } from '../contracts/inventory.js';
import { CopyContext } from '../contracts/presentation.js';
import { PromptEnhancementMode } from '../contracts/context.js';
import { ModelReference, RecoveryPolicy } from '../contracts/discovery.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Type, { type Static, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { PiConfig } from '../discovery/pi-protocol.js';
import { MipmuxRuntime } from '../runtime/mipmux-runtime.js';
import { PiRunner } from '../discovery/pi-runner.js';
import { ClaudeCodeRunner } from '../discovery/claude-runner.js';
import { checkRunnerCoverage, DiscoveryConfig, piRunnerConfig, type ClaudeCodeConfig } from '../discovery/discovery-config.js';
import { DiscoveryRunners } from '../discovery/discovery-runners.js';
import { parseModelReference } from '../discovery/selection.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';
import { mcpProtectedPaths } from '../discovery/mcp-config.js';
import type { DiscoveryPromptRenderer } from '../context/discovery-input.js';

const closed = { additionalProperties: false };
const absolute = Type.String({ pattern: '^/[^\\u0000]*$' });
/** Git and, by default, the user's configuration from `HOME` and `XDG_CONFIG_HOME`, whose excludes file Git applies. */
const GitHost = Type.Object({ executable: absolute, userConfiguration: Type.Optional(Type.Object({ home: absolute,
  xdgConfigHome: Type.Union([absolute, Type.Null()]) }, closed)) }, closed);
/**
 * The MCP tools a server offers. `core` offers `context_builder`, `context_job` and `context_prepare`, which build packets
 * through Context Builder and prepare them; `full` adds the workspace, exploration and manual-packet tools.
 */
export const ToolSet = Type.Enum(['core', 'full']);
export type ToolSet = Static<typeof ToolSet>;
/** Resolved host settings with every path, policy and limit explicit. Library hosts construct this form directly. */
export const HostConfig = Type.Object({ copyContext: CopyContext, ignoreSettings: Type.Optional(IgnoreSettings), cachePath: absolute, nativeExecutable: absolute,
  nativeEnvironment: Type.Record(Type.String(), Type.String()),
  terminationGraceMs: Type.Integer({ minimum: 0, maximum: 2147483647 }),
  credentialPaths: Type.Array(absolute),
  git: Type.Union([GitHost, Type.Null()]), discovery: Type.Union([DiscoveryConfig, Type.Null()]),
  defaultMaxOutputBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  contextBudgetUnits: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  defaultEnhancementMode: Type.Optional(PromptEnhancementMode),
  tools: ToolSet,
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
/** How discovery starts Claude Code: an executable in place of the Claude Agent SDK's own, and environment entries for the child. */
const ClaudeCodeFile = Type.Object({ executable: Type.Optional(absolute), environment: Type.Optional(Type.Record(Type.String(), Type.String())) }, closed);
/**
 * `allowedModels` lists the `provider/model` references a build request may select besides the configured model.
 * `modelsPath` configures the Pi runner and `claudeCode` the Claude Code runner, each required when a model needs it.
 */
const DiscoveryFile = Type.Object({ ...Type.Partial(Type.Omit(PiConfig, ['provider', 'model', 'thinking', 'policy'])).properties,
  ...Type.Pick(PiConfig, ['provider', 'model', 'thinking']).properties, policy: Type.Optional(PolicyFile),
  allowedModels: Type.Optional(Type.Array(ModelReference)), claudeCode: Type.Optional(ClaudeCodeFile) }, closed);
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
  /** Directory containing the package's `dist` directory. */
  readonly packageRoot: string;
  /** Resolves a Node platform-architecture target only when nativeExecutable has no explicit override. */
  readonly resolveNativeExecutable: (target: string) => string;
}
export function currentConfigHost(): ConfigHost {
  return { platform: process.platform, arch: process.arch, home: homedir(), env: process.env,
    packageRoot: fileURLToPath(new URL('../..', import.meta.url)), resolveNativeExecutable: target => {
      try { return fileURLToPath(import.meta.resolve(`#mipmux-native/${target}`)); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
          throw new WorkspaceFailure('nativeHelperUnavailable');
        }
        throw error;
      }
    } };
}
export function defaultConfigPath(host: ConfigHost): string {
  return join(host.env.XDG_CONFIG_HOME ?? join(host.home, '.config'), 'mipmux', 'config.json');
}

/** RPCE's default copy state: Auto file tree, automatic codemaps, no Git inclusion, customizations or custom presets. */
const defaultCopyContext: CopyContext = { current: { fileTreeMode: 'Auto', codeMapUsage: 'auto', gitInclusion: 'none' },
  customizations: { includeFiles: null, includeUserPrompt: null, includeFileTree: null, fileTreeMode: null, codeMapUsage: null, gitInclusion: null },
  codeMapsGloballyDisabled: false, activeGitRoot: null, presets: [] };
/** Pi 1.5.0 defaults for the settings in RecoveryPolicy; provider requests time out with the HTTP idle timeout. */
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
 * budget, 48000-byte exploration replies, a 1000 ms termination grace and the `core` MCP tools. Discovery takes Pi's `auth.json` from `$PI_CODING_AGENT_DIR` or `~/.pi/agent`,
 * the shipped discovery template, codemode and Pi's recovery defaults, merged field by field with the file's overrides.
 */
export function resolveHostConfig(file: ConfigFile, host: ConfigHost): HostConfig {
  const cacheRoot = host.platform === 'darwin' ? join(host.home, 'Library', 'Caches') : host.env.XDG_CACHE_HOME ?? join(host.home, '.cache');
  const config: HostConfig = {
    copyContext: file.copyContext ?? defaultCopyContext,
    cachePath: file.cachePath ?? join(cacheRoot, 'mipmux'),
    nativeExecutable: file.nativeExecutable ?? host.resolveNativeExecutable(`${host.platform}-${host.arch}`),
    nativeEnvironment: file.nativeEnvironment ?? {},
    terminationGraceMs: file.terminationGraceMs ?? defaultTerminationGraceMs,
    credentialPaths: file.credentialPaths ?? [],
    git: file.git === null ? null : { executable: file.git?.executable ?? defaultGitExecutable,
      userConfiguration: file.git?.userConfiguration ?? userGitConfiguration(host) },
    discovery: file.discovery ? resolveDiscovery(file.discovery, host) : null,
    defaultMaxOutputBytes: file.defaultMaxOutputBytes ?? defaultMaxOutputBytes,
    contextBudgetUnits: file.contextBudgetUnits ?? defaultContextBudgetUnits,
    tools: file.tools ?? 'core',
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

/**
 * Claude Code's settings: its executable, and an environment of `HOME`, `PATH` and `USER` from this process (on macOS,
 * Claude Code needs `USER` to find its login in the Keychain) with the file's entries over them. Claude Code's own
 * configuration directory and file under that `HOME`, or `CLAUDE_CONFIG_DIR`, are protected from context collection.
 */
function resolveClaudeCode(file: Static<typeof ClaudeCodeFile>, host: ConfigHost): ClaudeCodeConfig {
  const inherited = (['PATH', 'USER'] as const).flatMap(name => {
    const value = host.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  const home = file.environment?.HOME ?? host.home;
  return { executable: file.executable ?? null, environment: { HOME: host.home, ...Object.fromEntries(inherited), ...file.environment },
    configPaths: [file.environment?.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), join(home, '.claude.json')] };
}

function resolveDiscovery(file: Static<typeof DiscoveryFile>, host: ConfigHost): DiscoveryConfig {
  const config: DiscoveryConfig = {
    provider: file.provider, model: file.model, thinking: file.thinking,
    allowedModels: (file.allowedModels ?? []).map(parseModelReference),
    promptTemplatePath: file.promptTemplatePath ?? join(host.packageRoot, 'dist', 'prompts', 'discovery.md'),
    mcp: file.mcp ?? null,
    pi: file.modelsPath === undefined ? null : resolvePi(file, file.modelsPath, host),
    claudeCode: file.claudeCode ? resolveClaudeCode(file.claudeCode, host) : null,
  };
  checkRunnerCoverage(config, { pi: config.pi !== null, claudeCode: config.claudeCode !== null });
  return config;
}

function resolvePi(file: Static<typeof DiscoveryFile>, modelsPath: string, host: ConfigHost): NonNullable<DiscoveryConfig['pi']> {
  const policy = file.policy ?? {}, httpIdleTimeoutMs = policy.httpIdleTimeoutMs ?? piPolicyDefaults.httpIdleTimeoutMs;
  return {
    modelsPath,
    authPath: file.authPath ?? join(host.env.PI_CODING_AGENT_DIR ?? join(host.home, '.pi', 'agent'), 'auth.json'),
    environment: file.environment ?? {},
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
/** The files discovery reads credentials or settings from, which context collection never reads. */
function discoveryCredentialPaths(discovery: DiscoveryConfig): string[] {
  return [...(discovery.pi ? [discovery.pi.authPath, discovery.pi.modelsPath] : []), ...(discovery.claudeCode?.configPaths ?? []),
    ...(discovery.mcp ? mcpProtectedPaths(discovery.mcp) : [])];
}

/** The configured runners and the defaults that select between them; Claude Code runs in `<cachePath>/claude-code`. */
function composeDiscovery(discovery: DiscoveryConfig, runtime: MipmuxRuntime, cachePath: string): DiscoveryRunners {
  const render: DiscoveryPromptRenderer = (operation, signal) => runtime.renderPresentation(operation, signal);
  const pi = piRunnerConfig(discovery);
  return new DiscoveryRunners(discovery, pi && new PiRunner(pi, runtime.supervisor, render),
    discovery.claudeCode && new ClaudeCodeRunner({ claudeCode: discovery.claudeCode, promptTemplatePath: discovery.promptTemplatePath,
      mcp: discovery.mcp, workingDirectory: join(cachePath, 'claude-code') }, runtime.supervisor, render));
}

export function compose(config: HostConfig, configurationPath: string | null) {
  const discovery = config.discovery;
  const runtimeOptions = { copyContext: config.copyContext, cachePath: config.cachePath, nativeExecutable: config.nativeExecutable,
    contextBudgetUnits: config.contextBudgetUnits,
    nativeEnvironment: config.nativeEnvironment, terminationGraceMs: config.terminationGraceMs,
    credentialPaths: [...config.credentialPaths, ...(configurationPath === null ? [] : [configurationPath]),
      ...(discovery ? discoveryCredentialPaths(discovery) : [])],
  };
  if (config.git) Object.assign(runtimeOptions, { git: config.git });
  if (config.ignoreSettings) Object.assign(runtimeOptions, { ignoreSettings: config.ignoreSettings });
  if (config.defaultEnhancementMode !== undefined) Object.assign(runtimeOptions, { defaultEnhancementMode: config.defaultEnhancementMode });
  const runtime = new MipmuxRuntime(runtimeOptions);
  const runner = discovery && composeDiscovery(discovery, runtime, config.cachePath);
  return { runtime, runner, client: runtime.createClient(runner) };
}
