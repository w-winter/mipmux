import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { inventoryFiles } from './verify-release.mjs';

const targets = ['darwin-arm64', 'linux-x64', 'linux-arm64'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJSON = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const helperName = target => `@w-winter/mipmux-${target}`;

function verifiedArchive(root, receiptPath) {
  const manifest = json(join(root, 'package.json')), inventoryBytes = readFileSync(join(root, 'release-inventory.json'));
  const inventory = JSON.parse(inventoryBytes), receipt = json(receiptPath);
  assert.equal(manifest.name, 'mipmux');
  assert.equal(inventory.schemaVersion, 1); assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, 'releaseVerified'); assert(targets.includes(inventory.target));
  assert.equal(manifest.version, inventory.version, 'Archive version differs from its manifest');
  assert.equal(receipt.target, inventory.target); assert.equal(receipt.inventorySHA256, hash(inventoryBytes));
  assert.equal(receipt.buildLockSHA256, inventory.buildLockSHA256);
  assert.equal(receipt.nativeSHA256, inventory.nativeLinkage.binarySHA256);
  assert.equal(hash(readFileSync(join(root, 'package-lock.json'))), inventory.buildLockSHA256);
  assert.equal(json(join(root, 'dist/dependency-identity.json')).buildLockSHA256, inventory.buildLockSHA256);
  assert.deepEqual(inventoryFiles(root).filter(file => file.path !== 'release-inventory.json'), inventory.files,
    'Archive differs from the verified release inventory');
  assert.equal(hash(readFileSync(join(root, 'libexec', inventory.target, 'MipmuxBridge'))), receipt.nativeSHA256);
  const applicationSHA256 = hash(JSON.stringify(inventory.files.filter(file => file.kind === 'file' && file.path.startsWith('dist/'))
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))));
  return { manifest, inventory, applicationSHA256, releaseInventorySHA256: receipt.inventorySHA256 };
}

function helperManifest(manifest, target, linkage) {
  const [os, cpu] = target.split('-');
  if (os === 'linux') {
    assert(linkage.glibcSymbolFloor && linkage.glibcSymbolFloor.localeCompare('2.35', 'en', { numeric: true }) <= 0,
      'Linux helper must require glibc 2.35 or earlier');
  }
  const result = { name: helperName(target), version: manifest.version, description: `Native mipmux helper for ${target}${os === 'linux' ? ' (glibc 2.35+)' : ''}`,
    license: manifest.license, repository: manifest.repository, homepage: manifest.homepage, bugs: manifest.bugs,
    os: [os], cpu: [cpu],
    exports: { './MipmuxBridge': './MipmuxBridge' },
    files: ['MipmuxBridge', 'linkage.json', 'ThirdPartyLicenses', 'THIRD_PARTY_NOTICES.md'],
    publishConfig: { access: 'public' } };
  if (os === 'linux') result.libc = ['glibc'];
  return result;
}

function copy(root, staging, paths) {
  for (const path of paths) {
    mkdirSync(dirname(join(staging, path)), { recursive: true }); copyFileSync(join(root, path), join(staging, path));
  }
}

function pack(staging, destination, identity) {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
    cwd: staging, encoding: 'utf8', maxBuffer: Infinity, env: { PATH: process.env.PATH, HOME: destination, npm_config_userconfig: '/dev/null',
      npm_config_globalconfig: join(staging, '.global-npmrc'), npm_config_cache: join(destination, '.npm-cache'), npm_config_update_notifier: 'false' },
  }));
  assert.equal(packed.length, 1);
  const stagedFiles = inventoryFiles(staging).filter(file => file.kind === 'file');
  const packedPaths = new Set(packed[0].files.map(file => file.path));
  for (const file of stagedFiles.filter(file => !file.path.startsWith('node_modules/'))) {
    assert(packedPaths.has(file.path), `Missing package file: ${file.path}`);
  }
  const files = stagedFiles.filter(file => packedPaths.has(file.path));
  assert.deepEqual(packed[0].files.map(file => file.path).sort(), files.map(file => file.path).sort());
  const filename = join(destination, packed[0].filename), bytes = readFileSync(filename);
  const inventory = filename.replace(/\.tgz$/u, '.inventory.json');
  const publication = identity.kind === 'mainNpmPackage'
    ? { ...identity, production: identity.production.filter(entry => packedPaths.has(`${entry.path}/package.json`)),
      omittedOptionalPeers: identity.production.filter(entry => !packedPaths.has(`${entry.path}/package.json`)).map(entry => {
        assert(entry.devOptional, `Required production dependency omitted from npm bundle: ${entry.path}`);
        return entry;
      }) }
    : identity;
  const result = { schemaVersion: 1, ...publication, filename: basename(filename), bytes: bytes.length,
    sha256: hash(bytes), integrity: integrity(bytes), files };
  writeJSON(inventory, result);
  console.log(JSON.stringify({ ...result, files: files.length, filename, inventory }));
}

function readHelper(path, source) {
  const receipt = json(path.replace(/\.tgz$/u, '.inventory.json')), bytes = readFileSync(path);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, 'nativeNpmPackage');
  assert.equal(receipt.filename, basename(path)); assert.equal(receipt.sha256, hash(bytes));
  assert.equal(receipt.integrity, integrity(bytes)); assert.equal(receipt.bytes, bytes.length);
  assert(targets.includes(receipt.target)); assert.equal(receipt.name, helperName(receipt.target));
  assert.equal(receipt.version, source.manifest.version, 'Helper version differs from the main package');
  assert.equal(receipt.buildLockSHA256, source.inventory.buildLockSHA256, 'Helper build lock differs from the main package');
  assert.equal(receipt.applicationSHA256, source.applicationSHA256, 'Helper application identity differs from the main package');
  const entry = name => JSON.parse(execFileSync('tar', ['-xOf', path, `package/${name}`], { encoding: 'utf8' }));
  const linkage = entry('linkage.json');
  assert.deepEqual(entry('package.json'), helperManifest(source.manifest, receipt.target, linkage));
  assert.equal(linkage.binarySHA256, receipt.nativeSHA256);
  const binary = receipt.files.find(file => file.path === 'MipmuxBridge');
  assert(binary && binary.mode & 0o111, 'Helper binary must be executable');
  assert.equal(hash(execFileSync('tar', ['-xOf', path, 'package/MipmuxBridge'], { maxBuffer: binary.bytes })), receipt.nativeSHA256);
  return receipt;
}

const [operation, root, receiptPath, destination, ...helperPaths] = process.argv.slice(2);
assert((operation === 'helper' && helperPaths.length === 0 || operation === 'main' && helperPaths.length === targets.length) &&
  [root, receiptPath, destination, ...helperPaths].every(path => path && isAbsolute(path)),
  'Usage: package-npm.mjs helper <absolute-extracted-archive-root> <absolute-verifier-receipt.json> <absolute-output-directory>\n' +
  '   or: package-npm.mjs main <absolute-extracted-archive-root> <absolute-verifier-receipt.json> <absolute-output-directory> <helper.tgz> <helper.tgz> <helper.tgz>');
const source = verifiedArchive(root, receiptPath), { manifest, inventory } = source;
const helpers = helperPaths.map(path => readHelper(path, source));
if (operation === 'main') assert.deepEqual(helpers.map(helper => helper.target).sort(), [...targets].sort(), 'Expected one helper per target');
mkdirSync(destination, { mode: 0o700 });
const staging = join(destination, 'package-input'); mkdirSync(staging);
const notices = inventory.files.filter(file => file.kind === 'file' &&
  (file.path === 'LICENSE' || file.path === 'THIRD_PARTY_NOTICES.md' || file.path.startsWith('ThirdPartyLicenses/'))).map(file => file.path);
copy(root, staging, notices);
const identity = { version: manifest.version, buildLockSHA256: inventory.buildLockSHA256,
  applicationSHA256: source.applicationSHA256, releaseInventorySHA256: source.releaseInventorySHA256 };
if (operation === 'helper') {
  const target = inventory.target, native = join(staging, 'MipmuxBridge');
  copyFileSync(join(root, 'libexec', target, 'MipmuxBridge'), native); chmodSync(native, 0o755);
  writeJSON(join(staging, 'linkage.json'), inventory.nativeLinkage);
  writeJSON(join(staging, 'package.json'), helperManifest(manifest, target, inventory.nativeLinkage));
  pack(staging, destination, { ...identity, kind: 'nativeNpmPackage', name: helperName(target), target,
    nativeSHA256: inventory.nativeLinkage.binarySHA256 });
} else {
  const { private: unpublished, scripts, devDependencies, ...published } = manifest;
  const optionalDependencies = Object.fromEntries(targets.map(target => [helperName(target), manifest.version]));
  Object.assign(published, { imports: { '#mipmux-native/*': '@w-winter/mipmux-*/MipmuxBridge' }, optionalDependencies,
    bundleDependencies: Object.keys(manifest.dependencies),
    os: ['darwin', 'linux'], cpu: ['arm64', 'x64'], files: manifest.files.filter(path => path !== 'libexec' && path !== 'package-lock.json'),
    publishConfig: { access: 'public' } });
  copy(root, staging, ['README.md', ...inventory.files.filter(file => file.kind === 'file' && file.path.startsWith('dist/')).map(file => file.path)]);
  chmodSync(join(staging, 'dist/cli/main.js'), 0o755);
  writeJSON(join(staging, 'package.json'), published);
  const lock = json(join(root, 'package-lock.json'));
  const installed = json(join(root, 'node_modules/.package-lock.json'));
  const production = Object.entries(installed.packages).map(([path, entry]) => {
    const expected = lock.packages[path], dependency = json(join(root, path, 'package.json'));
    assert(expected && !expected.dev, `Unexpected production dependency: ${path}`);
    assert.equal(dependency.version, expected.version, `Production dependency version differs from lockfile: ${path}`);
    assert.equal(entry.integrity, expected.integrity, `Production dependency integrity differs from lockfile: ${path}`);
    assert(!dependency.os && !dependency.cpu && !dependency.libc && !entry.os && !entry.cpu && !entry.libc,
      `Platform-specific production dependency cannot be bundled: ${path}`);
    return { path, version: expected.version, integrity: expected.integrity, devOptional: expected.devOptional === true, peer: expected.peer === true };
  });
  for (const name of Object.keys(optionalDependencies)) {
    assert(!installed.packages[`node_modules/${name}`], `Native helper cannot be bundled: ${name}`);
  }
  cpSync(join(root, 'node_modules'), join(staging, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  pack(staging, destination, { ...identity, kind: 'mainNpmPackage', name: manifest.name, production,
    helpers: helpers.map(({ name, target, version, integrity }) => ({ name, target, version, integrity })) });
}
