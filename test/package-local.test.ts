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

test('local package audits resources and executes relocated library, native, CLI, MCP and discovery prompt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'smip-package-'));
  execFileSync(process.execPath, [resolve('scripts/package-local.mjs'), directory], { stdio: 'pipe' });
  const receipt = JSON.parse(readFileSync(join(directory, 'inventory.json'), 'utf8'));
  const paths: string[] = receipt.files.map((file: { path: string }) => file.path);
  for (const path of ['dist/index.js', 'dist/index.d.ts', 'dist/cli/main.js', 'dist/discovery/pi-worker.js',
    'dist/prompts/discovery-v1.md', 'dist/dependency-identity.json', `libexec/${process.platform}-${process.arch}/SmipBridge`,
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
  const provider = await scriptedProvider(() => ({ kind: 'text', text: 'Complete diagnostic', stop: 'end_turn', tokens: 10 }));
  const prompt = join(directory, 'editable-discovery.md');
  const promptBytes = Buffer.concat([readFileSync(join(packageRoot, 'dist/prompts/discovery-v1.md')), Buffer.from('\nRELOCATED_EDITABLE_PROMPT\n')]);
  writeFileSync(prompt, promptBytes);
  provider.config.promptPath = prompt;
  const root = join(directory, 'source'), output = join(directory, 'out');
  mkdirSync(root); mkdirSync(output); writeFileSync(join(root, 'model.swift'), 'struct Relocated { let title: String }\n');
  const config = join(directory, 'config.json'), specPath = join(directory, 'spec.json'), requestPath = join(directory, 'request.json');
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output };
  writeFileSync(specPath, JSON.stringify(spec));
  writeFileSync(config, JSON.stringify({ cachePath: join(directory, 'cache'), nativeExecutable: native, nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [], search: null, git: null, discovery: provider.config, defaultMaxOutputBytes: 10000 }));
  const workspace = JSON.parse(execFileSync(join(installed, 'node_modules/.bin/smip'), ['workspace', '--spec', specPath, '--config', config], { cwd: '/', encoding: 'utf8' }));
  assert(workspace.entries.some((entry: { structural?: { record: { outcome: { kind: string } } } }) => entry.structural?.record.outcome.kind === 'ready'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  const client = new Client({ name: 'relocation-test', version: '1' });
  try {
    await client.connect(transport); assert.equal((await client.listTools()).tools.length, 16);
    writeFileSync(requestPath, JSON.stringify({ workspace: spec, requestId: 'relocation', request: {
      task: 'Inspect', constraints: '', purpose: 'investigation', requiredSources: [], documents: [], patches: [],
      discoveryHints: [], outputName: 'packet', allowance: { kind: 'net', method: 'utf8-21-over-80-v1', units: 10000, overheadReserved: true } } }));
    const result = await new Promise<string>((resolveResult, reject) => {
      execFile(process.execPath,
        [command, 'build', '--request', requestPath, '--config', config], { cwd: '/' }, (error, stdout) => {
          if (error && error.code !== 2) reject(error); else resolveResult(stdout);
        });
    });
    const terminal = JSON.parse(result);
    assert.equal(terminal.state, 'blocked'); assert.equal(terminal.discovery.acceptedRuns, 1);
    assert.equal(terminal.discovery.workerClosed, true); assert.equal(terminal.discovery.prompt, 'resolved');
    assert.equal(terminal.discovery.buildLockSHA256, receipt.buildLockSHA256);
    assert.equal(terminal.discovery.promptSHA256, createHash('sha256').update(promptBytes).digest('hex'));
    assert(JSON.stringify(provider.requests.at(-1)?.system).includes('RELOCATED_EDITABLE_PROMPT'));
    writeFileSync(join(directory, 'relocation-receipt.json'), JSON.stringify({ installed, packageSHA256: receipt.sha256, installLockSHA256, terminal }));
    mkdirSync(resolve('test-output'), { recursive: true });
    writeFileSync(resolve('test-output/group-e-relocation.json'), JSON.stringify({ directory, installed, receipt: join(directory, 'relocation-receipt.json') }));
  } finally { await client.close(); await provider.close(); }

});
