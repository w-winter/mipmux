import { nativeDiscoveryRenderer } from './fixtures/render-discovery-prompt.js';
import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import { admitMcpConfiguration } from '../src/discovery/mcp-config.js';
import { compose } from '../src/cli/config.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';

const server = { url: 'https://example.invalid/mcp', exposure: 'hidden', toolExposure: { read_ticket: 'direct' } };
test('MCP configuration rejects unsafe input before worker startup and keeps diagnostics free of values', async t => {
  const provider = await scriptedProvider(() => { throw new Error('No model permitted'); });
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 0 });
  const spawn = supervisor.spawn.bind(supervisor);
  let piWorkers = 0;
  t.mock.method(supervisor, 'spawn', (spec: Parameters<typeof spawn>[0]) => {
    if (spec.args.some(arg => arg.endsWith('/pi-worker.js'))) { piWorkers++; throw new Error('No Pi spawn permitted'); }
    return spawn(spec);
  });
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { diagnostics.push(chunk.toString()); return true; });
  try {
    const cases: [unknown, string][] = [
      [{ mcpServers: {} }, 'invalidMcpConfiguration'],
      [{ mcpServers: { ctrl: { ...server, command: 'DO_NOT_LOG' } } }, 'invalidMcpConfiguration'],
      [{ mcpServers: { ctrl: { ...server, auth: { provider: 'anthropic' } } } }, 'invalidMcpConfiguration'],
      [{ mcpServers: { ctrl: { ...server, exposure: 'direct' } } }, 'invalidMcpConfiguration'],
      [{ mcpServers: { ctrl: { ...server, toolExposure: { 'read*': 'direct' } } } }, 'invalidMcpConfiguration'],
      [{ mcpServers: { ctrl: { ...server, url: 'http://example.invalid/DO_NOT_LOG' } } }, 'invalidMcpConfiguration'],
      [{ mcpServers: { ctrl: { ...server, headers: { Authorization: '!DO_NOT_LOG' } } } }, 'nonLiteralMcpValue'],
      [{ mcpServers: { ctrl: { ...server, headers: { Authorization: '${DO_NOT_LOG}' } } } }, 'nonLiteralMcpValue'],
      [{ mcpServers: { ctrl: { ...server, headers: { 'Bad\nName': { value: 'DO_NOT_LOG' } } } } }, 'invalidMcpConfiguration'],
      [{ mcpServers: { ctrl: { ...server, oauth: { clientSecret: '$DO_NOT_LOG' } } } }, 'nonLiteralMcpValue'],
    ];
    for (const [index, [value, code]] of cases.entries()) {
      const agentDirectory = join(provider.directory, String(index)); await mkdir(agentDirectory, { mode: 0o700 });
      await writeFile(join(agentDirectory, 'mcp.json'), JSON.stringify(value));
      await assert.rejects(new PiRunner({ ...provider.config, mcp: { agentDirectory } }, supervisor, nativeDiscoveryRenderer(supervisor)).run(
        { tokenBudget: 10000, enhancementMode: 'fullRewrite' as const, task: 'Inspect', purpose: 'investigation', initialContext: 'Fixture context', fileTree: '', currentPrompt: 'Fixture message', restrictsReviewGitToExplicitReadOnly: true, constraints: '', roots: [], hints: [] }, { call: async () => {} }, new AbortController().signal, () => {}), { code });
    }
    const agentDirectory = join(provider.directory, 'private'); await mkdir(agentDirectory, { mode: 0o700 });
    await assert.rejects(admitMcpConfiguration({ agentDirectory }, new AbortController().signal), { code: 'unreadableMcpConfiguration' });
    await mkdir(join(agentDirectory, 'mcp.json'));
    await assert.rejects(admitMcpConfiguration({ agentDirectory }, new AbortController().signal), { code: 'nonRegularMcpConfiguration' });
    await chmod(agentDirectory, 0o750);
    await assert.rejects(admitMcpConfiguration({ agentDirectory }, new AbortController().signal), { code: 'mcpDirectoryNotPrivate' });
    assert.equal(piWorkers, 0); assert.equal(provider.requests.length, 0);
    assert(diagnostics.some(line => line.includes('mcpConfigurationRejected'))); assert(!diagnostics.join('').includes('DO_NOT_LOG'));
  } finally { await supervisor.close(); await provider.close(); }
});

test('native literal escapes pass unchanged to the SDK while executable references are rejected', async () => {
  const provider = await scriptedProvider(() => { throw new Error('No model permitted'); });
  const agentDirectory = join(provider.directory, 'private'); await mkdir(agentDirectory, { mode: 0o700 });
  try {
    await fc.assert(fc.asyncProperty(fc.string(), async literal => {
      const encoded = literal.replaceAll('$', () => '$$').replace(/^!/, '$!');
      await writeFile(join(agentDirectory, 'mcp.json'), JSON.stringify({ mcpServers: { ctrl: { ...server, oauth: { clientSecret: encoded } } } }));
      const admitted = await admitMcpConfiguration({ agentDirectory }, new AbortController().signal);
      assert.equal(admitted.configuration.mcpServers.ctrl?.oauth?.clientSecret, encoded);
    }));
  } finally { await provider.close(); }
});

test('host composition excludes MCP state and symlink targets from source admission', async () => {
  const provider = await scriptedProvider(() => { throw new Error('No model permitted'); });
  const root = join(provider.directory, 'root'), agentDirectory = join(root, 'private'), output = join(provider.directory, 'out');
  await mkdir(root); await mkdir(agentDirectory, { mode: 0o700 }); await mkdir(output);
  await writeFile(join(root, 'configuration.txt'), JSON.stringify({ mcpServers: { ctrl: server } }));
  await symlink(join(root, 'configuration.txt'), join(agentDirectory, 'mcp.json'));
  await writeFile(join(root, 'tokens.txt'), 'synthetic'); await symlink(join(root, 'tokens.txt'), join(agentDirectory, 'mcp-auth.json'));
  const { runtime } = compose({ copyContext: copyContext(), cachePath: join(provider.directory, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [], terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {},
    discovery: { ...provider.config, mcp: { agentDirectory } }, git: null, defaultMaxOutputBytes: 10000 }, null);
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] }, new AbortController().signal);
    const operation = await workspace.openOperation(new AbortController().signal);
    for (const path of ['private/mcp.json', 'private/mcp-auth.json', 'configuration.txt', 'tokens.txt']) {
      await assert.rejects(operation.readSource({ root: 'r', path }), /unavailableSource/);
    }
    await operation.close(); await workspace.close();
  } finally { await runtime.close(); await provider.close(); }
});
