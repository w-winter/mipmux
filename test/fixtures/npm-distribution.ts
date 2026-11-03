import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { npmRegistry } from './npm-registry.js';
import { toolJSON, type JsonValue } from './tool-json.js';
import { scriptedProvider } from './scripted-provider.js';

const json = (path: string): JsonValue => JSON.parse(readFileSync(path, 'utf8'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const writeJSON = (path: string, value: JsonValue) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const packageManifest = Compile(Type.Object({ name: Type.String(), version: Type.String(), private: Type.Optional(Type.Boolean()),
  scripts: Type.Optional(Type.Record(Type.String(), Type.String())),
  dependencies: Type.Optional(Type.Record(Type.String(), Type.String())), bundleDependencies: Type.Optional(Type.Array(Type.String())),
  optionalDependencies: Type.Optional(Type.Record(Type.String(), Type.String())) }));
const lockValidator = Compile(Type.Object({ packages: Type.Record(Type.String(), Type.Object({ version: Type.String(),
  dev: Type.Optional(Type.Boolean()), integrity: Type.Optional(Type.String()), resolved: Type.Optional(Type.String()) })) }));
const Packed = Type.Object({ filename: Type.String(), inventory: Type.String(), integrity: Type.String() });
const packedValidator = Compile(Packed);
type Packed = Static<typeof Packed>;
const targets = ['darwin-arm64', 'linux-x64', 'linux-arm64'];
const readyJob = Compile(Type.Object({ state: Type.Literal('ready'), bundle: Type.Object({ directory: Type.String() }),
  discovery: Type.Object({ workerClosed: Type.Literal(true), buildLockSHA256: Type.String(), toolCalls: Type.Record(Type.String(), Type.Integer()) }) }));
const preparedBundle = Compile(Type.Object({ kind: Type.Literal('ready'), directory: Type.String(),
  context: Type.Object({ path: Type.String() }) }));
type NpmDiscoveryProof = { job: ReturnType<typeof readyJob.Parse>; prepared: ReturnType<typeof preparedBundle.Parse>; requests: number };

export async function verifyNpmDistribution(packageRoot: string, verificationReceipt: string, directory: string) {
  const manifest = packageManifest.Parse(json(join(packageRoot, 'package.json')));
  const output = join(directory, 'npm'); mkdirSync(output);
  const script = resolve('scripts/package-npm.mjs');
  const pack = (...args: string[]) => packedValidator.Parse(JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' })));
  const helpers: { filename: string; inventory: string; integrity: string }[] = [];
  for (const target of targets) {
    let archiveRoot = packageRoot, receiptPath = verificationReceipt;
    if (target !== `${process.platform}-${process.arch}`) {
      // Foreign-platform archives are synthetic boundary fixtures; their executables are never run.
      archiveRoot = join(output, `fixture-${target}`); mkdirSync(archiveRoot);
      const lock = readFileSync(join(packageRoot, 'package-lock.json'));
      const nativePath = `libexec/${target}/MipmuxBridge`, binary = Buffer.from(`fixture native ${target}\n`);
      const files = ['package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
        ...execFileSync('find', ['dist', 'ThirdPartyLicenses', '-type', 'f'], { cwd: packageRoot, encoding: 'utf8' }).trim().split('\n')];
      for (const path of files) {
        mkdirSync(dirname(join(archiveRoot, path)), { recursive: true });
        copyFileSync(join(packageRoot, path), join(archiveRoot, path));
      }
      mkdirSync(dirname(join(archiveRoot, nativePath)), { recursive: true }); writeFileSync(join(archiveRoot, nativePath), binary);
      chmodSync(join(archiveRoot, nativePath), 0o755);
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { inventoryFiles } from ${JSON.stringify(pathToFileURL(resolve('scripts/verify-release.mjs')).href)};
        import { readFileSync, writeFileSync } from 'node:fs';
        import { createHash } from 'node:crypto';
        const root = process.argv[1], target = process.argv[2];
        const hash = bytes => createHash('sha256').update(bytes).digest('hex');
        const source = JSON.parse(readFileSync(process.argv[3]));
        writeFileSync(root + '/release-inventory.json', JSON.stringify({ ...source, target,
          nativeLinkage: { binarySHA256: hash(readFileSync(root + '/libexec/' + target + '/MipmuxBridge')),
            glibcSymbolFloor: '2.35' }, files: inventoryFiles(root) }) + '\\n');
      `, archiveRoot, target, join(packageRoot, 'release-inventory.json')]);
      receiptPath = join(output, `fixture-${target}-receipt.json`);
      writeJSON(receiptPath, { schemaVersion: 1, kind: 'releaseVerified', target, buildLockSHA256: digest(lock),
        inventorySHA256: digest(readFileSync(join(archiveRoot, 'release-inventory.json'))), nativeSHA256: digest(binary) });
    }
    helpers.push(pack('helper', archiveRoot, receiptPath, join(output, target)));
  }
  assert.throws(() => pack('main', packageRoot, verificationReceipt, join(output, 'duplicate-target'),
    ...helpers.map(() => helpers[0]!.filename)));
  const occupied = join(output, 'occupied'); mkdirSync(occupied);
  const existingArchive = join(occupied, `w-winter-mipmux-${process.platform}-${process.arch}-${manifest.version}.tgz`);
  writeFileSync(existingArchive, 'existing artifact');
  assert.throws(() => pack('helper', packageRoot, verificationReceipt, occupied));
  assert.equal(readFileSync(existingArchive, 'utf8'), 'existing artifact');
  const helperReceiptPath = helpers[0]!.inventory, originalReceipt = readFileSync(helperReceiptPath);
  const helperReceipt = json(helperReceiptPath);
  assert(Compile(Type.Object({ version: Type.String() }, { additionalProperties: true })).Check(helperReceipt));
  writeJSON(helperReceiptPath, { ...helperReceipt, version: '0.0.0' });
  try {
    assert.throws(() => pack('main', packageRoot, verificationReceipt, join(output, 'mismatched-version'),
      ...helpers.map(helper => helper.filename)), /Helper version differs/u);
  } finally { writeFileSync(helperReceiptPath, originalReceipt); }
  const main = pack('main', packageRoot, verificationReceipt, join(output, 'main'), ...helpers.map(helper => helper.filename));
  const mainManifest = packageManifest.Parse(JSON.parse(execFileSync('tar', ['-xOf', main.filename, 'package/package.json'], { encoding: 'utf8' })));
  assert.equal(mainManifest.name, 'mipmux'); assert.equal(mainManifest.private, undefined); assert.equal(mainManifest.scripts, undefined);
  assert.deepEqual(mainManifest.optionalDependencies, Object.fromEntries(targets.map(target => [`@w-winter/mipmux-${target}`, manifest.version])));
  assert(manifest.dependencies);
  assert.deepEqual(mainManifest.bundleDependencies, Object.keys(manifest.dependencies));
  const entries = execFileSync('tar', ['-tzf', main.filename], { encoding: 'utf8', maxBuffer: Infinity }).trim().split('\n');
  assert(!entries.some(path => path.startsWith('package/libexec/') || path.startsWith('package/node_modules/@w-winter/')));
  assert(!entries.includes('package/npm-shrinkwrap.json')); assert(!entries.includes('package/package-lock.json'));
  assert(entries.includes('package/node_modules/@earendil-works/pi-coding-agent/package.json'));
  await verifyNpmInstallation(packageRoot, verificationReceipt, output, main, helpers);
}

export async function verifyNpmInstallation(packageRoot: string, verificationReceipt: string, output: string,
  main: Packed, helpers: readonly Packed[]) {
  const manifest = packageManifest.Parse(json(join(packageRoot, 'package.json')));
  const lock = lockValidator.Parse(json(join(packageRoot, 'package-lock.json')));
  const sourceInstalled = lockValidator.Parse(json(join(packageRoot, 'node_modules/.package-lock.json')));
  const artifact = Compile(Type.Object({ production: Type.Array(Type.Object({ path: Type.String(), version: Type.String(), integrity: Type.String() })),
    files: Type.Array(Type.Object({ path: Type.String(), sha256: Type.String() })) })).Parse(json(main.inventory));
  const sourceInventory = Compile(Type.Object({ files: Type.Array(Type.Union([
    Type.Object({ kind: Type.Literal('file'), path: Type.String(), sha256: Type.String() }),
    Type.Object({ kind: Type.Literal('directory'), path: Type.String() }),
    Type.Object({ kind: Type.Literal('symlink'), path: Type.String(), target: Type.String() }),
  ])) })).Parse(json(join(packageRoot, 'release-inventory.json')));
  const sourceHashes = new Map(sourceInventory.files.filter(file => file.kind === 'file').map(file => [file.path, file.sha256]));
  const registry = await npmRegistry([main.filename, ...helpers.map(helper => helper.filename)]);
  const home = join(output, 'home'), project = join(output, 'consumer'); mkdirSync(home); mkdirSync(project);
  const userconfig = join(home, 'npmrc'), globalconfig = join(home, 'global-npmrc'); writeFileSync(userconfig, ''); writeFileSync(globalconfig, '');
  assert(process.env.PATH);
  const env = { HOME: home, PATH: process.env.PATH, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, npm_config_cache: join(home, 'cache'),
    npm_config_update_notifier: 'false' };
  writeJSON(join(project, 'package.json'), { name: 'npm-distribution-consumer', version: '1.0.0', private: true });
  try {
    const npmVersion = (await promisify(execFile)('npm', ['--version'], { cwd: project, env })).stdout.trim();
    await promisify(execFile)('npm', ['install', `mipmux@${manifest.version}`, '--registry', registry.origin,
      '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: project, env });
    assert.deepEqual(registry.failures, []);
    const installedRoot = join(project, 'node_modules/mipmux'), installedLock = lockValidator.Parse(json(join(project, 'package-lock.json')));
    const production = [];
    for (const entry of artifact.production) {
      const path = entry.path; assert(sourceInstalled.packages[path], path);
      const expected = lock.packages[path]; assert(expected && !expected.dev, path);
      assert.equal(entry.version, expected.version, path); assert.equal(entry.integrity, expected.integrity, path);
      const nested = `node_modules/mipmux/${path}`;
      const actual = packageManifest.Parse(json(join(project, nested, 'package.json')));
      assert.equal(actual.version, expected.version, path);
      assert(installedLock.packages[nested], path);
      production.push({ path, installedPath: nested, version: actual.version, integrity: entry.integrity });
    }
    const bundledFiles = artifact.files.filter(file => file.path.startsWith('node_modules/'));
    for (const file of bundledFiles) {
      assert.equal(file.sha256, sourceHashes.get(file.path), file.path);
      assert.equal(digest(readFileSync(join(installedRoot, file.path))), file.sha256, file.path);
    }
    const helperName = `@w-winter/mipmux-${process.platform}-${process.arch}`;
    const helper = join(project, 'node_modules', helperName);
    for (const [index, target] of targets.entries()) {
      const name = `@w-winter/mipmux-${target}`, path = join(project, 'node_modules', name);
      assert.equal(existsSync(path), name === helperName, name);
      assert(!existsSync(join(installedRoot, 'node_modules', name)), `Bundled native helper: ${name}`);
      assert.equal(installedLock.packages[`node_modules/${name}`]?.integrity, helpers[index]!.integrity);
    }
    const pi = join(installedRoot, 'node_modules/.bin/pi');
    assert(existsSync(pi), 'Bundled Pi CLI link is missing');
    const piVersion = execFileSync(pi, ['--version'], { cwd: '/', env, encoding: 'utf8' }).trim();
    assert.equal(piVersion, lock.packages['node_modules/@earendil-works/pi-coding-agent']?.version);
    const config = join(output, 'config.json'), source = join(output, 'source'), packets = join(output, 'packets');
    mkdirSync(source); mkdirSync(packets); writeFileSync(join(source, 'model.swift'), 'struct NpmRelocated { let title: String }\n');
    writeJSON(config, { cachePath: join(output, 'cache'), git: null, discovery: null });
    const spec = { roots: [{ name: 'r', absolutePath: source }], exclusions: [], outputRoot: packets };
    const specPath = join(output, 'spec.json'); writeJSON(specPath, spec);
    const command = join(project, 'node_modules/.bin/mipmux');
    const run = () => execFileSync(command, ['workspace', '--spec', specPath, '--config', config], { cwd: '/', env, encoding: 'utf8' });
    const workspace = Compile(Type.Object({ entries: Type.Array(Type.Object({ structural: Type.Optional(Type.Object({
      record: Type.Object({ outcome: Type.Object({ kind: Type.String() }) }) })) })) })).Parse(JSON.parse(run()));
    assert(workspace.entries.some(entry => entry.structural?.record.outcome.kind === 'ready'));
    writeFileSync(join(project, 'library.mjs'), `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MipmuxRuntime, verifyBundle } from 'mipmux';
import { createMcpServer } from 'mipmux/mcp';
assert.equal(typeof MipmuxRuntime, 'function'); assert.equal(typeof verifyBundle, 'function');
assert.equal(typeof createMcpServer, 'function');
const runtime = new MipmuxRuntime({ ...JSON.parse(readFileSync(process.argv[2], 'utf8')),
  nativeExecutable: process.argv[3], cachePath: process.argv[4] });
try {
  const signal = new AbortController().signal;
  const workspace = await runtime.declare(JSON.parse(readFileSync(process.argv[5], 'utf8')), signal);
  const inventory = await workspace.refresh(signal);
  assert(inventory.entries.some(entry => entry.structural?.record.outcome.kind === 'ready'));
  await workspace.close();
} finally { await runtime.close(); }\n`);
    execFileSync(process.execPath, [join(project, 'library.mjs'), join(dirname(verificationReceipt), 'runtime-options.json'),
      join(helper, 'MipmuxBridge'), join(output, 'library-cache'), specPath], { cwd: '/', env });
    const provider = await scriptedProvider((_summary, index) => index === 1
      ? { kind: 'tool', name: 'codemode', input: { code: 'const reply = await tools.draft_inspect({ view: "metadata", maxOutputBytes: 10000, continuation: null }); return { state: reply.kind, marker: "npm-codemode-reached" };' }, stop: 'tool_use', tokens: 10 }
      : { kind: 'text', text: 'Complete.', stop: 'end_turn', tokens: 10 });
    provider.config.promptTemplatePath = join(installedRoot, 'dist/prompts/discovery.md');
    writeJSON(config, { cachePath: join(output, 'cache'), git: null, discovery: provider.config });
    const client = new Client({ name: 'npm-distribution', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [join(installedRoot, 'dist/cli/main.js'), 'mcp', '--tools', 'full', '--config', config], cwd: '/', env, stderr: 'pipe' });
    let discoveryProof: NpmDiscoveryProof;
    try {
      await client.connect(transport);
      const workspaceId = Compile(Type.Object({ id: Type.String() })).Parse(toolJSON(await client.callTool({ name: 'workspace_declare', arguments: { spec } }))).id;
      const search = Compile(Type.Object({ counts: Type.Object({ matchingLines: Type.Integer() }) })).Parse(toolJSON(await client.callTool({
        name: 'file_search', arguments: { workspaceId, input: { mode: 'content', query: { kind: 'literal', text: 'NpmRelocated' } } } })));
      assert.equal(search.counts.matchingLines, 1);
      const jobId = Compile(Type.Object({ jobId: Type.String() })).Parse(toolJSON(await client.callTool({ name: 'context_builder',
        arguments: { workspace: spec, task: 'Inspect the NpmRelocated model.', purpose: 'investigation', outputName: 'npm-ready',
          budgetUnits: 10000, enhancementMode: 'preserve', required: [{ root: 'r', path: 'model.swift' }] } }))).jobId;
      let snapshot: unknown;
      do {
        snapshot = toolJSON(await client.callTool({ name: 'context_job', arguments: { op: 'wait', jobId, durationMs: 10000 } }));
      } while (!Compile(Type.Object({ localSettled: Type.Boolean() })).Parse(snapshot).localSettled);
      const ready = readyJob.Parse(snapshot);
      assert.equal(ready.discovery.buildLockSHA256, digest(readFileSync(join(packageRoot, 'package-lock.json'))));
      assert.equal(ready.discovery.toolCalls.codemode, 1);
      assert(JSON.stringify(provider.requests[1]?.messages.at(-1)).includes('npm-codemode-reached'));
      const finalPrompt = 'Explain the NpmRelocated model.';
      const prepared = preparedBundle.Parse(toolJSON(await client.callTool({ name: 'context_prepare',
        arguments: { workspace: spec, bundle: 'npm-ready', prompt: finalPrompt, outputName: 'npm-prepared' } })));
      const context = readFileSync(prepared.context.path, 'utf8');
      assert(context.includes('struct NpmRelocated')); assert(context.includes(finalPrompt));
      assert.equal(provider.requests.length, 2);
      discoveryProof = { job: ready, prepared, requests: provider.requests.length };
    } finally { await client.close(); await provider.close(); }
    writeJSON(config, { cachePath: join(output, 'cache'), git: null, discovery: null });
    const nestedHelper = join(installedRoot, 'node_modules', helperName);
    mkdirSync(dirname(nestedHelper), { recursive: true }); renameSync(helper, nestedHelper);
    assert(Compile(Type.Object({ entries: Type.Array(Type.Unknown()) })).Parse(JSON.parse(run())).entries.length > 0);
    renameSync(nestedHelper, helper);
    const native = join(helper, 'MipmuxBridge'), detached = join(output, 'detached-helper'); renameSync(helper, detached);
    const missing = spawnSync(command, ['workspace', '--spec', specPath, '--config', config], { cwd: '/', env, encoding: 'utf8' });
    assert.equal(missing.status, 1); assert.deepEqual(JSON.parse(missing.stdout), { kind: 'failed', code: 'nativeHelperUnavailable' });
    writeJSON(config, { cachePath: join(output, 'override-cache'), git: null, discovery: null, nativeExecutable: join(detached, 'MipmuxBridge') });
    assert(Compile(Type.Object({ entries: Type.Array(Type.Unknown()) })).Parse(JSON.parse(run())).entries.length > 0);
    renameSync(detached, helper);
    assert(existsSync(native));
    writeJSON(config, { cachePath: join(output, 'cache'), git: null, discovery: null });
    writeJSON(join(output, 'receipt.json'), { kind: 'npmDistributionVerified', main, helpers, registryRequests: registry.requests,
      npmVersion, piVersion, production, bundledFileCount: bundledFiles.length, discovery: discoveryProof,
      command, missingHelper: JSON.parse(missing.stdout), explicitOverride: true });
    mkdirSync(resolve('test-output'), { recursive: true });
    writeJSON(resolve('test-output/npm-distribution.json'), { directory: output, receipt: join(output, 'receipt.json') });
  } finally { await registry.close(); }
}
