import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { DiscoveryReceipt } from '../src/contracts/discovery.js';

test('local package audits resources and executes relocated library, native, CLI, MCP and discovery prompt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'smip-package-'));
  execFileSync(process.execPath, [resolve('scripts/package-local.mjs'), directory], { stdio: 'pipe' });
  const receipt = JSON.parse(readFileSync(join(directory, 'inventory.json'), 'utf8'));
  const paths: string[] = receipt.files.map((file: { path: string }) => file.path);
  for (const path of ['dist/index.js', 'dist/index.d.ts', 'dist/cli/main.js', 'dist/discovery/pi-worker.js',
    'dist/dependency-identity.json', `libexec/${process.platform}-${process.arch}/SmipBridge`,
    'THIRD_PARTY_NOTICES.md', 'ThirdPartyLicenses/pcre2/LICENCE.md']) assert(paths.includes(path), path);
  assert(!paths.some(path => /(?:\.DS_Store|\.env|test-output|prompt-exports|node_modules|\.build)/u.test(path)));
  const bytes = readFileSync(join(directory, receipt.filename));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
  const archived = execFileSync('tar', ['-tzf', join(directory, receipt.filename)], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(archived.map(path => path.replace(/^package\//u, '')).sort(), paths.sort());
  const installed = join(directory, 'installed');
  mkdirSync(installed);
  writeFileSync(join(installed, 'package.json'), '{"private":true,"type":"module"}');
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, receipt.filename)], { cwd: installed });
  const installLockSHA256 = createHash('sha256').update(readFileSync(join(installed, 'package-lock.json'))).digest('hex');
  writeFileSync(join(directory, 'installed-dependencies.json'), execFileSync('npm', ['ls', '--all', '--json'], { cwd: installed }));
  writeFileSync(join(directory, 'installed-audit.json'), execFileSync('npm', ['audit', '--json'], { cwd: installed }));
  const packageRoot = join(installed, 'node_modules/smip');
  const native = join(packageRoot, `libexec/${process.platform}-${process.arch}/SmipBridge`);
  const command = join(packageRoot, 'dist/cli/main.js');
  writeFileSync(join(installed, 'import.mjs'), 'import {SmipRuntime, verifyBundle} from "smip"; if (typeof SmipRuntime !== "function" || typeof verifyBundle !== "function") throw Error("Missing API");');
  execFileSync(process.execPath, [join(installed, 'import.mjs')], { cwd: '/' });
  let requestInteraction = false, interactionCalls = 0;
  const provider = await scriptedProvider(() => requestInteraction && interactionCalls++ === 0
    ? { kind: 'tool', name: 'ask_user', input: { questions: [{ id: 'scope', question: 'Which context?', options: ['API', 'UI'],
      allows_multiple: true, allows_custom: true }] }, stop: 'tool_use', tokens: 10 }
    : { kind: 'text', text: 'Complete diagnostic', stop: 'end_turn', tokens: 10 });
  const prompt = join(directory, 'editable-discovery.md');
  const promptBytes = Buffer.from('# smip discovery v1\nRELOCATED_EDITABLE_PROMPT\n');
  writeFileSync(prompt, promptBytes);
  provider.config.prompt = { kind: 'file', path: prompt };
  const root = join(directory, 'source'), output = join(directory, 'out');
  mkdirSync(root); mkdirSync(output); writeFileSync(join(root, 'model.swift'), 'struct Relocated { let title: String }\n');
  const config = join(directory, 'config.json'), specPath = join(directory, 'spec.json'), requestPath = join(directory, 'request.json');
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output };
  writeFileSync(specPath, JSON.stringify(spec));
  writeFileSync(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(directory, 'cache'), nativeExecutable: native, nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], git: null, discovery: provider.config, defaultMaxOutputBytes: 10000 }));
  const workspace = JSON.parse(execFileSync(join(installed, 'node_modules/.bin/smip'), ['workspace', '--spec', specPath, '--config', config], { cwd: '/', encoding: 'utf8' }));
  assert(workspace.entries.some((entry: { structural?: { record: { outcome: { kind: string } } } }) => entry.structural?.record.outcome.kind === 'ready'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  const client = new Client({ name: 'relocation-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } },
    capabilities: { elicitation: { form: {} } } });
  let questions = 0;
  client.setRequestHandler('elicitation/create', async request => {
    questions++;
    assert.equal(request.params.mode, 'form');
    return { action: 'accept', content: Object.fromEntries(Object.entries(request.params.requestedSchema.properties)
      .map(([key, field]) => [key, field.type === 'array' ? ['API'] : 'installed custom context'])) };
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of ['draft_dispose', 'context_builder_dispose']) assert(tools.tools.some(tool => tool.name === name));
    writeFileSync(requestPath, JSON.stringify({ workspace: spec, requestId: 'relocation', request: {
      task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation', requiredSources: [], documents: [], patches: [],
      discoveryHints: [], outputName: 'packet', budgetUnits: 10000 } }));
    const result = await new Promise<string>((resolveResult, reject) => {
      execFile(process.execPath,
        [command, 'build', '--request', requestPath, '--config', config], { cwd: '/' }, (error, stdout) => {
          if (error && error.code !== 2) reject(error); else resolveResult(stdout);
        });
    });
    const terminal = JSON.parse(result);
    assert.equal(terminal.state, 'ready'); assert.equal(terminal.discovery.acceptedRuns, 1);
    assert.equal(terminal.discovery.workerClosed, true); assert.equal(terminal.discovery.prompt, 'resolved');
    assert.equal(terminal.discovery.buildLockSHA256, receipt.buildLockSHA256);
    assert.equal(terminal.discovery.promptSHA256, createHash('sha256').update(promptBytes).digest('hex'));
    assert(JSON.stringify(provider.requests.at(-1)?.system).includes('RELOCATED_EDITABLE_PROMPT'));
    provider.config.prompt = { kind: 'rpce' };
    writeFileSync(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(directory, 'cache'), nativeExecutable: native, nativeEnvironment: {},
      terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], git: null,
      discovery: provider.config, defaultMaxOutputBytes: 10000 }));
    writeFileSync(requestPath, JSON.stringify({ workspace: spec, requestId: 'native-relocation', request: {
      task: 'Inspect', initialSelection: { codemapMode: 'automatic', sources: [] }, duplicateUserInstructionsAtTop: false,
      copyPreset: 'standard', storedPrompts: [], constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      requiredSources: [], documents: [], patches: [], discoveryHints: [], outputName: 'native-packet', budgetUnits: 10000 } }));
    const nativeResult = await new Promise<string>((resolveResult, reject) => {
      execFile(process.execPath, [command, 'build', '--request', requestPath, '--config', config], { cwd: '/' }, (error, stdout) => {
        if (error) reject(error); else resolveResult(stdout);
      });
    });
    const nativeTerminal = Compile(Type.Object({ state: Type.Literal('ready'), discovery: DiscoveryReceipt })).Parse(JSON.parse(nativeResult));
    assert.equal(nativeTerminal.state, 'ready'); assert(nativeTerminal.state === 'ready');
    assert.equal(nativeTerminal.discovery.promptVersion, 'rpce-43a9c29');
    assert(JSON.stringify(provider.requests.at(-1)?.system).includes('Leave the prompt COMPLETELY unchanged'));
    assert(JSON.stringify(provider.requests.at(-1)?.messages).includes('<current_prompt_content>'));
    requestInteraction = true;
    const workspaceId = Compile(Type.Object({ id: Type.String() })).Parse((await client.callTool({ name: 'workspace_declare',
      arguments: { spec } })).structuredContent).id;
    const jobId = Compile(Type.Object({ jobId: Type.String() })).Parse((await client.callTool({ name: 'context_builder',
      arguments: { workspaceId, requestId: 'interactive-relocation', request: {
        task: 'Inspect', initialSelection: { codemapMode: 'manual', sources: [] }, duplicateUserInstructionsAtTop: false,
        copyPreset: 'standard', storedPrompts: [], constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
        requiredSources: [{ kind: 'full', source: { root: 'r', path: 'model.swift' } }], documents: [], patches: [],
        discoveryHints: [], outputName: 'interactive-packet', budgetUnits: 10000, clarification: {},
      } },
    })).structuredContent).jobId;
    const interactive = Compile(Type.Object({ state: Type.Literal('ready'), localSettled: Type.Literal(true),
      discovery: DiscoveryReceipt })).Parse((await client.callTool({ name: 'context_builder_wait',
      arguments: { jobId, durationMs: 10000 } })).structuredContent);
    assert.equal(questions, 1); assert.equal(interactive.discovery.promptVersion, 'custom-file-v1');
    assert(JSON.stringify(provider.requests.at(-1)!.messages).includes('installed custom context'));
    writeFileSync(join(directory, 'relocation-receipt.json'), JSON.stringify({ installed, packageSHA256: receipt.sha256,
      installLockSHA256, terminal, nativeTerminal, interactive }));
    mkdirSync(resolve('test-output'), { recursive: true });
    writeFileSync(resolve('test-output/group-e-relocation.json'), JSON.stringify({ directory, installed, receipt: join(directory, 'relocation-receipt.json') }));
  } finally { await client.close(); await provider.close(); }

});
