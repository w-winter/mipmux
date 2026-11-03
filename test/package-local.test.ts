import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, lchmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import { controlledHttpMcp } from './fixtures/controlled-http-mcp.js';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { PiDiscoveryReceipt, TokenUsage } from '../src/contracts/discovery.js';
import { Manifest } from '../src/contracts/context.js';
import { toolJSON } from './fixtures/tool-json.js';
import { verifyNpmDistribution } from './fixtures/npm-distribution.js';

const packageVersion = Compile(Type.Object({ version: Type.String() }));
const dependencyLock = Compile(Type.Object({ packages: Type.Record(Type.String(), Type.Object({
  version: Type.String(), dev: Type.Optional(Type.Boolean()),
})) }));

// MCP ready snapshots give the number of discovery completions, their summed token usage and their tool calls counted by
// name instead of their records.
const readyDiscovery = Type.Object({ ...PiDiscoveryReceipt.properties, completions: Type.Integer({ minimum: 1 }), usage: TokenUsage,
  toolCalls: Type.Record(Type.String(), Type.Integer({ minimum: 1 })) }, { additionalProperties: false });

async function waitForSettlement(client: Client, jobId: string) {
  const observation = Compile(Type.Object({ localSettled: Type.Boolean() }));
  for (;;) {
    const reply = await client.callTool({ name: 'context_job', arguments: { op: 'wait', jobId, durationMs: 10000 } });
    const snapshot = observation.Parse(toolJSON(reply));
    if (snapshot.localSettled) return reply;
  }
}

test('application build emits canonical declarations across compiler worker counts', () => {
  const compilerWorkerCounts = [1, 8];
  const directory = resolve('dist');
  const paths = readdirSync(resolve('src'), { recursive: true, encoding: 'utf8' })
    .filter(path => path.endsWith('.ts')).map(path => path.slice(0, -3) + '.d.ts').sort();
  const declarations = () => paths.map(path => ({
    path, sha256: createHash('sha256').update(readFileSync(join(directory, path))).digest('hex'),
  }));
  execFileSync('npm', ['exec', '--', 'tsc', '--singleThreaded', '--emitDeclarationOnly'], { stdio: 'pipe' });
  const expected = declarations();
  for (const workers of compilerWorkerCounts) {
    execFileSync('npm', ['run', 'build'], { env: { ...process.env, GOMAXPROCS: String(workers) }, stdio: 'pipe' });
    assert.deepEqual(declarations(), expected);
  }
  mkdirSync(resolve('test-output'), { recursive: true });
  writeFileSync(resolve('test-output/build-determinism.json'), JSON.stringify({ compilerWorkerCounts, declarations: expected }) + '\n');
});

test('local package audits resources and executes relocated library, native, CLI, MCP and discovery prompt', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mipmux-package-'));
  execFileSync(process.execPath, [resolve('scripts/package-local.mjs'), directory], { stdio: 'pipe' });
  const receipt = JSON.parse(readFileSync(join(directory, 'inventory.json'), 'utf8'));
  const paths: string[] = receipt.files.map((file: { path: string }) => file.path);
  for (const path of ['dist/index.js', 'dist/index.d.ts', 'dist/cli/main.js', 'dist/discovery/pi-worker.js',
    'dist/dependency-identity.json', 'dist/prompts/discovery.md', `libexec/${process.platform}-${process.arch}/MipmuxBridge`,
    'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'ThirdPartyLicenses/pcre2/LICENCE.md']) assert(paths.includes(path), path);
  assert(!paths.some(path => /(?:\.DS_Store|\.env|test-output|prompt-exports|node_modules|\.build)/u.test(path)));
  const bytes = readFileSync(join(directory, receipt.filename));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
  const archived = execFileSync('tar', ['-tzf', join(directory, receipt.filename)], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(archived.map(path => path.replace(/^package\//u, '')).sort(), paths.sort());
  const installed = join(directory, 'installed');
  mkdirSync(installed);
  execFileSync('tar', ['-xzf', join(directory, receipt.filename), '-C', installed]);
  const packageRoot = join(installed, 'package');
  const lockBytes = readFileSync(resolve('package-lock.json'));
  assert.deepEqual(readFileSync(join(packageRoot, 'package-lock.json')), lockBytes);
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: packageRoot });
  const installLockSHA256 = createHash('sha256').update(readFileSync(join(packageRoot, 'package-lock.json'))).digest('hex');
  assert.equal(installLockSHA256, receipt.buildLockSHA256);
  const lock = dependencyLock.Parse(JSON.parse(lockBytes.toString()));
  const installedLock = dependencyLock.Parse(JSON.parse(readFileSync(join(packageRoot, 'node_modules/.package-lock.json'), 'utf8')));
  for (const path of Object.keys(installedLock.packages)) {
    const expected = lock.packages[path];
    assert(expected && !expected.dev, path);
    const actual = packageVersion.Parse(JSON.parse(readFileSync(join(packageRoot, path, 'package.json'), 'utf8')));
    assert.equal(actual.version, expected.version, path);
  }
  writeFileSync(join(directory, 'installed-dependencies.json'), execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: packageRoot }));
  writeFileSync(join(directory, 'installed-audit.json'), execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: packageRoot }));
  const native = join(packageRoot, `libexec/${process.platform}-${process.arch}/MipmuxBridge`);
  const command = join(packageRoot, 'dist/cli/main.js');
  writeFileSync(join(packageRoot, 'import.mjs'), 'import {MipmuxRuntime, verifyBundle} from "mipmux"; if (typeof MipmuxRuntime !== "function" || typeof verifyBundle !== "function") throw Error("Missing API");');
  execFileSync(process.execPath, [join(packageRoot, 'import.mjs')], { cwd: '/' });
  const remote = await controlledHttpMcp(); t.after(() => remote.close());
  let phase: { kind: 'finish' } | { kind: 'question'; calls: number } |
    { kind: 'fetch'; calls: number; templatePath: string; updatedTemplate: Buffer } |
    { kind: 'hold'; entered: () => void } = { kind: 'finish' };
  const provider = await scriptedProvider(() => {
    if (phase.kind === 'hold') return { kind: 'hold', entered: phase.entered };
    if (phase.kind === 'question' && phase.calls++ === 0) return {
      kind: 'tool', name: 'ask_user', input: { questions: [{ id: 'scope', question: 'Which context?', options: ['API', 'UI'],
        allows_multiple: true, allows_custom: true }] }, stop: 'tool_use', tokens: 10 };
    if (phase.kind === 'fetch') {
      const call = phase.calls++;
      if (call === 0) {
        writeFileSync(phase.templatePath, phase.updatedTemplate);
        return { kind: 'tool', name: 'mcp__controlled__read_ticket', input: {}, stop: 'tool_use', tokens: 10 };
      }
      if (call === 1) {
        assert(JSON.stringify(provider.requests.at(-1)?.messages).includes('FETCHED_DOCUMENT_END'));
        return { kind: 'tool', name: 'draft_update', input: { expectedRevision: 0, maxOutputBytes: 10000,
          mutation: { kind: 'addDocument', document: { kind: 'suppliedDocument', id: 'installed-ticket', role: 'evidence',
            origin: remote.url, text: remote.text } } }, stop: 'tool_use', tokens: 10 };
      }
    }
    return { kind: 'text', text: 'Complete diagnostic', stop: 'end_turn', tokens: 10 };
  });
  const agentDirectory = join(directory, 'scout-mcp'); mkdirSync(agentDirectory, { mode: 0o700 });
  writeFileSync(join(agentDirectory, 'mcp.json'), JSON.stringify({ mcpServers: { controlled: {
    url: remote.url, exposure: 'hidden', toolExposure: { read_ticket: 'direct' },
    headers: { Authorization: 'Bearer synthetic$$$!mcp-token' },
  } } }));
  provider.config.mcp = { agentDirectory };
  const prompt = join(directory, 'discovery.md');
  const shippedTemplate = join(packageRoot, 'dist/prompts/discovery.md');
  copyFileSync(shippedTemplate, prompt, constants.COPYFILE_EXCL);
  const stockBytes = readFileSync(prompt), systemMarker = '<!-- mipmux:section system -->\n';
  const promptBytes = Buffer.from(stockBytes.toString().replace(systemMarker, systemMarker + 'RELOCATED_EDITABLE_PROMPT\n'));
  writeFileSync(prompt, promptBytes);
  provider.config.promptTemplatePath = prompt;
  const root = join(directory, 'source'), output = join(directory, 'out');
  mkdirSync(root); mkdirSync(output); writeFileSync(join(root, 'model.swift'), 'struct Relocated { let title: String }\n');
  const config = join(directory, 'config.json'), specPath = join(directory, 'spec.json'), requestPath = join(directory, 'request.json');
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output };
  writeFileSync(specPath, JSON.stringify(spec));
  writeFileSync(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(directory, 'cache'), nativeExecutable: native, nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, defaultEnhancementMode: 'augment', credentialPaths: [], git: null, discovery: provider.config, defaultMaxOutputBytes: 10000 }));
  const workspace = JSON.parse(execFileSync(command, ['workspace', '--spec', specPath, '--config', config], { cwd: '/', encoding: 'utf8' }));
  assert(workspace.entries.some((entry: { structural?: { record: { outcome: { kind: string } } } }) => entry.structural?.record.outcome.kind === 'ready'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp', '--tools', 'full', '--config', config], cwd: '/', stderr: 'pipe' });
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
    for (const name of ['draft_dispose', 'context_job']) assert(tools.tools.some(tool => tool.name === name));
    writeFileSync(requestPath, JSON.stringify({ workspace: spec, requestId: 'relocation', request: {
      task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '', purpose: 'investigation', requiredSources: [], documents: [], patches: [],
      discoveryHints: [], outputName: 'packet' } }));
    const result = await new Promise<string>((resolveResult, reject) => {
      execFile(process.execPath,
        [command, 'build', '--request', requestPath, '--config', config], { cwd: '/' }, (error, stdout) => {
          if (error && error.code !== 2) reject(error); else resolveResult(stdout);
        });
    });
    const terminal = Compile(Type.Object({ state: Type.Literal('ready'), discovery: PiDiscoveryReceipt,
      bundle: Type.Object({ manifest: Manifest }) })).Parse(JSON.parse(result));
    assert.equal(terminal.bundle.manifest.request.budgetUnits, 1000000);
    assert.equal(terminal.bundle.manifest.request.enhancementMode, 'augment');
    assert.equal(terminal.state, 'ready'); assert.equal(terminal.discovery.acceptedRuns, 1);
    assert.equal(terminal.discovery.workerClosed, true); assert.equal(terminal.discovery.prompt, 'resolved');
    assert.equal(terminal.discovery.buildLockSHA256, receipt.buildLockSHA256);
    assert.deepEqual(terminal.discovery.template.identity, { sha256: createHash('sha256').update(promptBytes).digest('hex'), byteCount: promptBytes.length });
    assert.notEqual(terminal.discovery.policyIdentity.sha256, terminal.discovery.template.identity.sha256);
    assert(JSON.stringify(provider.requests.at(-1)?.system).includes('RELOCATED_EDITABLE_PROMPT'));
    writeFileSync(prompt, stockBytes);
    writeFileSync(requestPath, JSON.stringify({ workspace: spec, requestId: 'native-relocation', request: {
      task: 'Inspect', initialSelection: { codemapMode: 'automatic', sources: [] }, duplicateUserInstructionsAtTop: false,
      copyPreset: 'standard', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
      requiredSources: [], documents: [], patches: [], discoveryHints: [], outputName: 'native-packet', budgetUnits: 10000 } }));
    const nativeResult = await new Promise<string>((resolveResult, reject) => {
      execFile(process.execPath, [command, 'build', '--request', requestPath, '--config', config], { cwd: '/' }, (error, stdout) => {
        if (error) reject(error); else resolveResult(stdout);
      });
    });
    const nativeTerminal = Compile(Type.Object({ state: Type.Literal('ready'), discovery: PiDiscoveryReceipt,
      bundle: Type.Object({ directory: Type.String() }) })).Parse(JSON.parse(nativeResult));
    assert.equal(nativeTerminal.state, 'ready'); assert(nativeTerminal.state === 'ready');
    assert.equal(nativeTerminal.discovery.templateVersion, 'mipmux-discovery-template-v1');
    assert.equal(nativeTerminal.discovery.template.identity.sha256, createHash('sha256').update(stockBytes).digest('hex'));
    assert(JSON.stringify(provider.requests.at(-1)?.system).includes('Leave the prompt COMPLETELY unchanged'));
    assert(JSON.stringify(provider.requests.at(-1)?.messages).includes('<discover_instructions>'));
    const verification = ['integrity', 'current'].map(mode => {
      const args = [command, 'verify', '--bundle', nativeTerminal.bundle.directory, '--mode', mode];
      if (mode === 'current') args.push('--config', config);
      const result = Compile(Type.Object({ kind: Type.Literal(mode === 'current' ? 'currentVerified' : 'verified'), manifest: Manifest })).Parse(JSON.parse(
        execFileSync(process.execPath, args, { cwd: '/', encoding: 'utf8' })));
      return { mode, requestDigest: result.manifest.requestDigest };
    });
    phase = { kind: 'question', calls: 0 };
    const workspaceId = Compile(Type.Object({ id: Type.String() })).Parse(toolJSON(await client.callTool({ name: 'workspace_declare',
      arguments: { spec } }))).id;
    const read = Compile(Type.Object({ kind: Type.Literal('read'), content: Type.String() })).Parse(toolJSON(await client.callTool({
      name: 'read_file', arguments: { workspaceId, input: { root: 'r', path: 'model.swift' } },
    })));
    assert.equal(read.content, 'struct Relocated { let title: String }\n');
    const search = Compile(Type.Object({ kind: Type.Literal('search'), counts: Type.Object({ matchingLines: Type.Integer() }) })).Parse(
      toolJSON(await client.callTool({ name: 'file_search', arguments: { workspaceId,
        input: { mode: 'content', query: { kind: 'literal', text: 'Relocated' } } } })));
    assert.equal(search.counts.matchingLines, 1);
    const request = { workspace: spec, task: 'Inspect', copyPreset: 'standard', enhancementMode: 'preserve', purpose: 'investigation',
      required: [{ root: 'r', path: 'model.swift' }], outputName: 'interactive-packet', budgetUnits: 10000 };
    const jobId = Compile(Type.Object({ jobId: Type.String() })).Parse(toolJSON(await client.callTool({ name: 'context_builder',
      arguments: { ...request, clarification: {} },
    }))).jobId;
    const interactiveReply = await waitForSettlement(client, jobId);
    writeFileSync(join(directory, 'interactive-wait.json'), JSON.stringify(interactiveReply));
    const interactiveValidator = Compile(Type.Object({ state: Type.Literal('ready'), localSettled: Type.Literal(true), discovery: readyDiscovery }));
    const interactive = toolJSON(interactiveReply);
    assert(interactiveValidator.Check(interactive), JSON.stringify(interactiveReply));
    assert.equal(questions, 1); assert.equal(interactive.discovery.templateVersion, 'mipmux-discovery-template-v1');
    assert(JSON.stringify(provider.requests.at(-1)!.messages).includes('installed custom context'));
    const updatedTemplate = Buffer.from(stockBytes.toString().replace(systemMarker, systemMarker + 'UPDATED_EXTERNAL_TEMPLATE\n'));
    const fetchRequestStart = provider.requests.length;
    phase = { kind: 'fetch', calls: 0, templatePath: prompt, updatedTemplate };
    const fetchedId = Compile(Type.Object({ jobId: Type.String() })).Parse(toolJSON(await client.callTool({ name: 'context_builder',
      arguments: { ...request, outputName: 'http-packet' } }))).jobId;
    const fetched = Compile(Type.Object({ state: Type.Literal('ready'), localSettled: Type.Literal(true), discovery: readyDiscovery,
      bundle: Type.Object({ directory: Type.String() }) })).Parse(toolJSON(await waitForSettlement(client, fetchedId)));
    const verified = Compile(Type.Object({ kind: Type.Literal('verified'), manifest: Manifest })).Parse(JSON.parse(execFileSync(
      process.execPath, [command, 'verify', '--bundle', fetched.bundle.directory, '--mode', 'integrity'], { cwd: '/', encoding: 'utf8' })));
    const document = verified.manifest.materials.find(material => material.id === 'document:installed-ticket');
    assert(document?.kind === 'document');
    assert.equal(document.spans.length, 1);
    const context = readFileSync(join(fetched.bundle.directory, 'context.md'));
    for (const span of document.spans) assert.deepEqual(context.subarray(span.offset, span.offset + span.length), Buffer.from(remote.text));
    assert.deepEqual(remote.calls, ['read_ticket']);
    assert.equal(fetched.discovery.mcp?.shutdown, 'dispatched');
    assert.equal(fetched.discovery.template.identity.sha256, createHash('sha256').update(stockBytes).digest('hex'));
    for (const request of provider.requests.slice(fetchRequestStart)) assert(!JSON.stringify(request.system).includes('UPDATED_EXTERNAL_TEMPLATE'));
    const observed = Compile(Type.Object({ state: Type.Literal('ready') })).Parse(toolJSON(await client.callTool({
      name: 'context_job', arguments: { op: 'status', jobId: fetchedId },
    })));
    let entered!: () => void;
    const entering = new Promise<void>(resolveEntered => { entered = resolveEntered; });
    phase = { kind: 'hold', entered };
    const beforeCancel = readdirSync(output).sort();
    const cancelledId = Compile(Type.Object({ jobId: Type.String() })).Parse(toolJSON(await client.callTool({ name: 'context_builder',
      arguments: { ...request, outputName: 'cancel-packet' } }))).jobId;
    const waiting = waitForSettlement(client, cancelledId);
    await Promise.race([entering, waiting.then(() => { throw new Error('Installed job settled before the provider hold'); })]);
    await client.callTool({ name: 'context_job', arguments: { op: 'cancel', jobId: cancelledId } });
    const cancelled = Compile(Type.Object({ state: Type.Literal('cancelled'), localSettled: Type.Literal(true),
      discovery: PiDiscoveryReceipt })).Parse(toolJSON(await waiting));
    assert.equal(cancelled.discovery.workerClosed, true); assert.equal(cancelled.discovery.parentToolsSettled, true);
    assert.equal(cancelled.discovery.template.identity.sha256, createHash('sha256').update(updatedTemplate).digest('hex'));
    assert(JSON.stringify(provider.requests.at(-1)?.system).includes('UPDATED_EXTERNAL_TEMPLATE'));
    assert.deepEqual(readdirSync(output).sort(), beforeCancel);
    writeFileSync(join(directory, 'relocation-receipt.json'), JSON.stringify({ installed, packageSHA256: receipt.sha256,
      installLockSHA256, terminal, nativeTerminal, verification, read, search, interactive, fetched, observed, cancelled }));
    mkdirSync(resolve('test-output'), { recursive: true });
    writeFileSync(resolve('test-output/group-e-relocation.json'), JSON.stringify({ directory, installed, receipt: join(directory, 'relocation-receipt.json') }));
  } finally { await client.close(); await provider.close(); }

});

test('release archive carries locked production dependencies and verifies offline after extraction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mipmux-release-'));
  const output = join(directory, 'release');
  execFileSync(process.execPath, [resolve('scripts/package-release.mjs'), output], { stdio: 'pipe' });
  const version = packageVersion.Parse(JSON.parse(readFileSync(resolve('package.json'), 'utf8'))).version;
  const name = `mipmux-${version}-${process.platform}-${process.arch}`;
  const inventory = Compile(Type.Object({ filename: Type.String(), sha256: Type.String(), buildLockSHA256: Type.String(),
    nativeLinkage: Type.Object({ binarySHA256: Type.String() }) })).Parse(
    JSON.parse(readFileSync(join(output, `${name}.inventory.json`), 'utf8')));
  assert.equal(inventory.filename, `${name}.tar.gz`);
  const archive = readFileSync(join(output, inventory.filename));
  assert.equal(createHash('sha256').update(archive).digest('hex'), inventory.sha256);
  const relocated = join(directory, 'relocated');
  mkdirSync(relocated);
  execFileSync('tar', ['-xzf', join(output, inventory.filename), '-C', relocated]);
  const packageRoot = join(relocated, name);
  assert.deepEqual(readFileSync(join(packageRoot, 'package-lock.json')), readFileSync(resolve('package-lock.json')));
  for (const path of ['dist/cli/main.js', `libexec/${process.platform}-${process.arch}/MipmuxBridge`]) {
    assert(lstatSync(join(packageRoot, path)).mode & 0o111, path);
  }
  const lock = dependencyLock.Parse(JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8')));
  const installed = dependencyLock.Parse(JSON.parse(readFileSync(join(packageRoot, 'node_modules/.package-lock.json'), 'utf8')));
  for (const path of Object.keys(installed.packages)) {
    const expected = lock.packages[path];
    assert(expected && !expected.dev, path);
    assert.equal(packageVersion.Parse(JSON.parse(readFileSync(join(packageRoot, path, 'package.json'), 'utf8'))).version,
      expected.version, path);
  }
  assert(lstatSync(join(packageRoot, 'node_modules/.bin/pi')).isSymbolicLink());
  assert.equal(readlinkSync(join(packageRoot, 'node_modules/.bin/pi')), readlinkSync(join(output, name, 'node_modules/.bin/pi')));
  if (process.platform === 'darwin') lchmodSync(join(packageRoot, 'node_modules/.bin/pi'), 0o777);
  for (const path of ['src', 'native', 'test', 'dist-test', '.env', '.npmrc', 'node_modules/typescript']) {
    assert(!existsSync(join(packageRoot, path)), path);
  }
  const evidence = join(directory, 'evidence');
  execFileSync(process.execPath, [join(packageRoot, 'verify-release.mjs'), packageRoot, evidence], {
    cwd: '/', env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe',
  });
  const receipt = Compile(Type.Object({ kind: Type.String(), buildLockSHA256: Type.String(), nativeSHA256: Type.String() }))
    .Parse(JSON.parse(readFileSync(join(evidence, 'receipt.json'), 'utf8')));
  assert.equal(receipt.kind, 'releaseVerified');
  assert.equal(receipt.buildLockSHA256, inventory.buildLockSHA256);
  assert.equal(receipt.nativeSHA256, inventory.nativeLinkage.binarySHA256);
  for (const file of ['workspace.json', 'structure.json', 'search.json', 'render.json', 'integrity.json', 'current.json', 'library.json']) {
    assert(existsSync(join(evidence, file)), file);
  }
  const search = Compile(Type.Object({ counts: Type.Object({ matchingLines: Type.Integer() }) }))
    .Parse(JSON.parse(readFileSync(join(evidence, 'search.json'), 'utf8')));
  assert.equal(search.counts.matchingLines, 1);
  assert.throws(() => execFileSync(process.execPath, [join(packageRoot, 'verify-release.mjs'), packageRoot, evidence], { stdio: 'pipe' }));
  const promptPath = join(packageRoot, 'dist/prompts/discovery.md'), promptBytes = readFileSync(promptPath);
  writeFileSync(promptPath, 'modified archive resource');
  assert.throws(() => execFileSync(process.execPath,
    [join(packageRoot, 'verify-release.mjs'), packageRoot, join(directory, 'modified-evidence')], { stdio: 'pipe' }));
  writeFileSync(promptPath, promptBytes);
  mkdirSync(resolve('test-output'), { recursive: true });
  writeFileSync(resolve('test-output/release-packaging.json'), JSON.stringify({ directory, archive: join(output, inventory.filename),
    inventory: join(output, `${name}.inventory.json`), receipt: join(evidence, 'receipt.json') }) + '\n');
  await verifyNpmDistribution(packageRoot, join(evidence, 'receipt.json'), directory);
});
