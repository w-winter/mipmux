import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJSON = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

export function inventoryFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map(entry => {
    const absolute = join(entry.parentPath, entry.name), path = relative(root, absolute);
    const stat = lstatSync(absolute), mode = stat.mode & 0o777;
    if (stat.isDirectory()) return { path, kind: 'directory', mode };
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute), resolved = relative(root, resolve(dirname(absolute), target));
      assert(!isAbsolute(target) && resolved !== '..' && !resolved.startsWith('../'), `External package symlink: ${path}`);
      // Symlink permissions vary by filesystem and do not govern access to their targets.
      return { path, kind: 'symlink', target };
    }
    assert(stat.isFile(), `Unsupported package entry: ${path}`);
    const bytes = readFileSync(absolute);
    return { path, kind: 'file', mode, bytes: bytes.length, sha256: hash(bytes) };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function verifyRelease(packageRoot, evidence) {
  mkdirSync(evidence, { mode: 0o700 });
  const inventory = json(join(packageRoot, 'release-inventory.json'));
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.target, `${process.platform}-${process.arch}`);
  assert.deepEqual(inventoryFiles(packageRoot).filter(file => file.path !== 'release-inventory.json'), inventory.files,
    'Extracted package does not match its release inventory');
  assert.equal(hash(readFileSync(join(packageRoot, 'package-lock.json'))), inventory.buildLockSHA256);
  assert.equal(json(join(packageRoot, 'dist/dependency-identity.json')).buildLockSHA256, inventory.buildLockSHA256);
  const native = join(packageRoot, 'libexec', inventory.target, 'MipmuxBridge');
  const nativeSHA256 = hash(readFileSync(native));
  assert.equal(nativeSHA256, inventory.nativeLinkage.binarySHA256);
  const command = join(packageRoot, 'dist/cli/main.js');
  const source = join(evidence, 'source'), output = join(evidence, 'packets'), home = join(evidence, 'home');
  for (const path of [source, output, home]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(source, 'model.swift'), 'public struct ReleaseSmoke {\n  public let title: String\n}\n');
  const copyContext = {
    current: { fileTreeMode: 'Auto', codeMapUsage: 'auto', gitInclusion: 'none' },
    customizations: { includeFiles: null, includeUserPrompt: null, includeFileTree: null,
      fileTreeMode: null, codeMapUsage: null, gitInclusion: null },
    codeMapsGloballyDisabled: false, activeGitRoot: null, presets: [],
  };
  const runtimeOptions = { copyContext, cachePath: join(evidence, 'cache'), nativeExecutable: native,
    nativeEnvironment: {}, terminationGraceMs: 1000, credentialPaths: [], contextBudgetUnits: 100000,
    defaultEnhancementMode: 'preserve' };
  const { nativeExecutable, ...cliOptions } = runtimeOptions;
  const config = join(evidence, 'config.json'), spec = join(evidence, 'workspace-spec.json');
  writeJSON(config, { ...cliOptions, git: null, discovery: null, tools: 'full', defaultMaxOutputBytes: 10000 });
  writeJSON(join(evidence, 'runtime-options.json'), runtimeOptions);
  const workspace = { roots: [{ name: 'r', absolutePath: source }], exclusions: [], outputRoot: output };
  writeJSON(spec, workspace);
  const env = { HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, PATH: dirname(process.execPath) };
  const commands = [];
  function run(name, args) {
    const stdout = `${name}.json`, stderr = `${name}.stderr`;
    const out = openSync(join(evidence, stdout), 'wx', 0o600), err = openSync(join(evidence, stderr), 'wx', 0o600);
    let result;
    try { result = spawnSync(process.execPath, args, { cwd: evidence, env, stdio: ['ignore', out, err] }); }
    finally { closeSync(out); closeSync(err); }
    commands.push({ command: process.execPath, args, stdout, stderr, status: result.status });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${name} failed: ${readFileSync(join(evidence, stdout), 'utf8')} ${readFileSync(join(evidence, stderr), 'utf8')}`);
    return json(join(evidence, stdout));
  }
  const warm = run('workspace', [command, 'workspace', '--spec', spec, '--config', config]);
  assert(warm.entries.some(entry => entry.structural?.record.outcome.kind === 'ready'));
  const structureInput = join(evidence, 'structure-input.json');
  writeJSON(structureInput, { maxOutputBytes: 10000, seeds: [{ kind: 'file', root: 'r', path: 'model.swift' }],
    selection: null, expand: 'none', depth: 1, signatures: true, size: 'medium' });
  const structure = run('structure', [command, 'tool', 'get_code_structure', '--workspace', spec, '--input', structureInput, '--config', config]);
  assert.equal(structure.kind, 'structure');
  assert(structure.files.some(file => file.content.includes('ReleaseSmoke')));
  const searchInput = join(evidence, 'search-input.json');
  writeJSON(searchInput, { mode: 'content', query: { kind: 'regex', text: '\\bReleaseSmoke\\b', caseSensitive: true, wholeWord: false },
    filters: { roots: [], paths: [], exclude: [], extensions: [] }, before: 0, after: 0, countOnly: false,
    maxResults: 50, maxOutputBytes: 10000, continuation: null });
  const search = run('search', [command, 'tool', 'file_search', '--workspace', spec, '--input', searchInput, '--config', config]);
  assert.equal(search.kind, 'search');
  assert.equal(search.counts.matchingLines, 1);
  const request = join(evidence, 'render-request.json'), draft = join(evidence, 'draft.json');
  const prompt = 'Inspect the ReleaseSmoke model.';
  writeJSON(request, { workspace, request: { task: prompt, initialSelection: { codemapMode: 'automatic', sources: [] },
    duplicateUserInstructionsAtTop: false, copyPreset: 'standard', constraints: '', purpose: 'investigation',
    requiredSources: [{ kind: 'full', source: { root: 'r', path: 'model.swift' } }],
    documents: [], patches: [], discoveryHints: [], outputName: 'release-smoke' } });
  writeJSON(draft, { selections: [], prompt });
  const rendered = run('render', [command, 'render', '--request', request, '--draft', draft, '--config', config]);
  assert.equal(rendered.kind, 'ready');
  assert(readFileSync(join(rendered.directory, 'context.md'), 'utf8').includes('public let title: String'));
  const integrity = run('integrity', [command, 'verify', '--bundle', rendered.directory, '--mode', 'integrity']);
  const current = run('current', [command, 'verify', '--bundle', rendered.directory, '--mode', 'current', '--config', config]);
  assert.equal(integrity.kind, 'verified');
  assert.equal(current.kind, 'currentVerified');
  const libraryScript = join(evidence, 'library-smoke.mjs');
  writeFileSync(libraryScript, `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { MipmuxRuntime, verifyBundle, verifyCurrentBundle } = await import(process.argv[2]);
const runtime = new MipmuxRuntime(JSON.parse(readFileSync(process.argv[3], 'utf8')));
try {
  const integrity = await verifyBundle(process.argv[4]);
  const current = await verifyCurrentBundle(process.argv[4], runtime, new AbortController().signal);
  assert.equal(integrity.kind, 'verified');
  assert.equal(current.kind, 'currentVerified');
  assert.equal(integrity.manifest.requestDigest, current.manifest.requestDigest);
  console.log(JSON.stringify({ kind: 'libraryVerified', requestDigest: current.manifest.requestDigest }));
} finally { await runtime.close(); }
`, { flag: 'wx', mode: 0o600 });
  const library = run('library', [libraryScript, pathToFileURL(join(packageRoot, 'dist/index.js')).href,
    join(evidence, 'runtime-options.json'), rendered.directory]);
  assert.equal(library.kind, 'libraryVerified');
  assert.equal(library.requestDigest, current.manifest.requestDigest);
  const receipt = { schemaVersion: 1, kind: 'releaseVerified', target: inventory.target, packageRoot,
    node: process.version, buildLockSHA256: inventory.buildLockSHA256, nativeSHA256,
    inventorySHA256: hash(readFileSync(join(packageRoot, 'release-inventory.json'))),
    bundle: rendered.directory, requestDigest: current.manifest.requestDigest, commands };
  writeJSON(join(evidence, 'receipt.json'), receipt);
  console.log(JSON.stringify({ kind: receipt.kind, receipt: join(evidence, 'receipt.json') }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [packageRoot, evidence, ...extra] = process.argv.slice(2);
  assert(packageRoot && evidence && isAbsolute(packageRoot) && isAbsolute(evidence) && !extra.length,
    'Usage: verify-release.mjs <absolute-extracted-package-root> <absolute-fresh-evidence-directory>');
  verifyRelease(packageRoot, evidence);
}
