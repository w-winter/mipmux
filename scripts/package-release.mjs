import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePackage } from './package-local.mjs';
import { inventoryFiles } from './verify-release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [destination, ...extra] = process.argv.slice(2);
assert(destination && isAbsolute(destination) && !extra.length, 'Usage: package-release.mjs <absolute-output-directory>');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `mipmux-${manifest.version}-${process.platform}-${process.arch}`;
mkdirSync(destination, { recursive: true, mode: 0o700 });
const staging = join(destination, name);
const staged = stagePackage(staging);
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging, stdio: ['ignore', 2, 2] });
const lock = JSON.parse(readFileSync(join(staging, 'npm-shrinkwrap.json'), 'utf8'));
const installed = JSON.parse(readFileSync(join(staging, 'node_modules/.package-lock.json'), 'utf8'));
for (const path of Object.keys(installed.packages)) {
  const expected = lock.packages[path];
  assert(expected && !expected.dev, `Unexpected production dependency: ${path}`);
  assert.equal(JSON.parse(readFileSync(join(staging, path, 'package.json'), 'utf8')).version, expected.version,
    `Production dependency version differs from lockfile: ${path}`);
}
copyFileSync(join(root, 'scripts/verify-release.mjs'), join(staging, 'verify-release.mjs'));
const inventory = { schemaVersion: 1, target: staged.target, version: manifest.version,
  buildLockSHA256: staged.buildLockSHA256, nativeLinkage: staged.nativeLinkage, files: inventoryFiles(staging) };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(readFileSync(join(staging, 'libexec', staged.target, 'MipmuxBridge'))), staged.nativeLinkage.binarySHA256);
writeFileSync(join(staging, 'release-inventory.json'), JSON.stringify(inventory, null, 2) + '\n', { flag: 'wx' });
const filename = `${name}.tar.gz`, archivePath = join(destination, filename);
const archiveFile = openSync(archivePath, 'wx', 0o600);
try {
  execFileSync('tar', ['--no-xattrs', '-czf', '-', '-C', destination, name], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', archiveFile, 2],
  });
} finally { closeSync(archiveFile); }
const archive = readFileSync(archivePath), sha256 = hash(archive);
const receipt = { ...inventory, filename, bytes: archive.length, sha256, files: inventoryFiles(staging) };
writeFileSync(join(destination, `${name}.inventory.json`), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
writeFileSync(join(destination, `${name}.sha256`), `${sha256}  ${filename}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ filename: archivePath, sha256, bytes: archive.length, files: receipt.files.length }));
