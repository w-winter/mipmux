import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { ConfigFile, resolveHostConfig, type ConfigHost } from '../src/cli/config.js';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const host: ConfigHost = { platform: 'linux', arch: 'x64', home: '/home/fixture', packageRoot: '/opt/mipmux',
  env: { XDG_CACHE_HOME: '/var/cache/fixture' } };

test('a partial configuration file resolves to explicit defaults and field-level policy overrides', () => {
  const file = Compile(ConfigFile).Parse({ credentialPaths: ['/home/fixture/private.json'], discovery: { provider: 'openai-codex',
    model: 'gpt-6.1-sol', thinking: 'medium', modelsPath: '/home/fixture/models.json',
    policy: { retry: { provider: { timeoutMs: 0 } }, compaction: { reserveTokens: 9000 } } } });
  assert.deepEqual(resolveHostConfig(file, host), {
    copyContext: { current: { fileTreeMode: 'Auto', codeMapUsage: 'auto', gitInclusion: 'none' },
      customizations: { includeFiles: null, includeUserPrompt: null, includeFileTree: null, fileTreeMode: null, codeMapUsage: null, gitInclusion: null },
      codeMapsGloballyDisabled: false, activeGitRoot: null, presets: [] },
    cachePath: '/var/cache/fixture/mipmux', nativeExecutable: '/opt/mipmux/libexec/linux-x64/MipmuxBridge', nativeEnvironment: {},
    terminationGraceMs: 1000, credentialPaths: ['/home/fixture/private.json'],
    git: { executable: '/usr/bin/git', userConfiguration: { home: '/home/fixture', xdgConfigHome: null } },
    defaultMaxOutputBytes: 48000, contextBudgetUnits: 200000, tools: 'core',
    discovery: { provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'medium', allowedModels: [],
      promptTemplatePath: '/opt/mipmux/dist/prompts/discovery.md', mcp: null, claudeCode: null,
      pi: { modelsPath: '/home/fixture/models.json', authPath: '/home/fixture/.pi/agent/auth.json', environment: {}, codemode: true,
        policy: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000,
          provider: { timeoutMs: 0, maxRetries: 0, maxRetryDelayMs: 60000 } },
        compaction: { enabled: true, reserveTokens: 9000, keepRecentTokens: 20000 },
        transport: 'auto', httpIdleTimeoutMs: 300000, websocketConnectTimeoutMs: 15000, cacheWarming: 'off' } } },
  });
  const macOS = resolveHostConfig({ git: null }, { ...host, platform: 'darwin', arch: 'arm64', env: { PI_CODING_AGENT_DIR: '/agent' } });
  assert.equal(macOS.cachePath, '/home/fixture/Library/Caches/mipmux');
  assert.equal(macOS.git, null);
  assert.equal(resolveHostConfig({ discovery: { provider: 'p', model: 'm', thinking: 'off', modelsPath: '/m.json' } },
    { ...host, env: { PI_CODING_AGENT_DIR: '/agent' } }).discovery?.pi?.authPath, '/agent/auth.json');
});

test('each configured or allowed model needs its runner, and a Claude-only configuration needs no Pi files', () => {
  const failure = Compile(Type.Object({ code: Type.Literal('invalidDiscoveryConfiguration'), details: Type.Object({ message: Type.String() }) }));
  const claude = { provider: 'claude-code', model: 'claude-sonnet-5-5', thinking: 'low' } as const;
  assert.throws(() => resolveHostConfig({ discovery: claude }, host),
    error => failure.Check(error) && error.details.message === 'claude-code/claude-sonnet-5-5 needs discovery.claudeCode.');
  assert.throws(() => resolveHostConfig({ discovery: { ...claude, allowedModels: ['openai-codex/gpt-6.1-sol'], claudeCode: {} } }, host),
    error => failure.Check(error) && error.details.message === 'openai-codex/gpt-6.1-sol needs discovery.modelsPath.');
  const resolved = resolveHostConfig({ discovery: { ...claude, claudeCode: { environment: { ANTHROPIC_API_KEY: 'key' } } } },
    { ...host, env: { PATH: '/usr/bin', USER: 'fixture', SHELL: '/bin/zsh' } });
  assert.equal(resolved.discovery?.pi, null);
  assert.deepEqual(resolved.discovery?.claudeCode, { executable: null,
    environment: { HOME: '/home/fixture', PATH: '/usr/bin', USER: 'fixture', ANTHROPIC_API_KEY: 'key' },
    configPaths: ['/home/fixture/.claude', '/home/fixture/.claude.json'] });
});

test('the CLI reads the default configuration path when --config is omitted', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-config-file-')), root = join(base, 'root'), configHome = join(base, 'config');
  await mkdir(root); await mkdir(join(base, 'out')); await mkdir(join(configHome, 'mipmux'), { recursive: true });
  await writeFile(join(root, 'notes.txt'), 'default configuration\n');
  await writeFile(join(configHome, 'mipmux', 'config.json'), JSON.stringify({ cachePath: join(base, 'cache'), git: null,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`) }));
  const spec = join(base, 'spec.json');
  await writeFile(spec, JSON.stringify({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: join(base, 'out') }));
  const output = execFileSync(process.execPath, [resolve('dist/cli/main.js'), 'workspace', '--spec', spec], { cwd: '/', encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: configHome } });
  const inventory = Compile(Type.Object({ entries: Type.Array(Type.Object({ path: Type.String() })) })).Parse(JSON.parse(output));
  assert(inventory.entries.some(entry => entry.path === 'notes.txt'));
});

test('allowed discovery models are provider/model references, split at the first slash', () => {
  const discovery = { provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'medium', modelsPath: '/m.json' } as const;
  const file = Compile(ConfigFile).Parse({ discovery: { ...discovery, allowedModels: ['anthropic/claude-haiku-4-5', 'openrouter/meta/llama-4'] } });
  assert.deepEqual(resolveHostConfig(file, host).discovery?.allowedModels,
    [{ provider: 'anthropic', model: 'claude-haiku-4-5' }, { provider: 'openrouter', model: 'meta/llama-4' }]);
  for (const reference of ['claude-haiku-4-5', '/claude', 'anthropic/', 'anthropic/claude haiku']) {
    assert.equal(Compile(ConfigFile).Check({ discovery: { ...discovery, allowedModels: [reference] } }), false, reference);
  }
});

test('mipmux config prints the resolved defaults and allowed models without paths, credentials or environment', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-config-command-')), config = join(base, 'config.json');
  const run = async () => JSON.parse((await promisify(execFile)(process.execPath, [resolve('dist/cli/main.js'), 'config', '--config', config],
    { cwd: '/' })).stdout);
  await writeFile(config, JSON.stringify({ contextBudgetUnits: 150000, credentialPaths: ['/secret/credential.json'], discovery: {
    provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'medium', modelsPath: '/secret/models.json', authPath: '/secret/auth.json',
    environment: { SECRET_TOKEN: 'synthetic-secret-value' }, allowedModels: ['anthropic/claude-haiku-4-5'] } }));
  const printed = await run();
  assert.deepEqual(printed, { kind: 'config', path: config, contextBudgetUnits: 150000, defaultEnhancementMode: 'augment', tools: 'core',
    discovery: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium', allowedModels: ['anthropic/claude-haiku-4-5'] } });
  assert(!JSON.stringify(printed).includes('secret'));
  await writeFile(config, JSON.stringify({ defaultEnhancementMode: 'preserve', tools: 'full' }));
  assert.deepEqual(await run(), { kind: 'config', path: config, contextBudgetUnits: 200000, defaultEnhancementMode: 'preserve', tools: 'full',
    discovery: null });
});
