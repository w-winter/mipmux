import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: ['ignore', 2, 2] });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function stagePackage(staging) {
  run(process.execPath, ['scripts/build-native.mjs', 'build', '--configuration', 'release']);
  run('npm', ['run', 'build']);
  run('npm', ['run', 'verify:vendor']);
  mkdirSync(staging, { mode: 0o755 });
  const target = `${process.platform}-${process.arch}`;
  const paths = ['package.json', 'npm-shrinkwrap.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    `libexec/${target}/MipmuxBridge`, 'dist/dependency-identity.json', 'dist/prompts/discovery.md'];
  for (const entry of readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const relative = join(entry.parentPath, entry.name).slice(join(root, 'src').length + 1).slice(0, -3);
    paths.push(`dist/${relative}.js`, `dist/${relative}.d.ts`);
  }
  paths.push('ThirdPartyLicenses/inventory.json', ...JSON.parse(readFileSync(join(root, 'ThirdPartyLicenses/inventory.json'))).map(file => file.path));
  const files = paths.sort().map(path => {
    const source = join(root, path === 'npm-shrinkwrap.json' ? 'package-lock.json' : path);
    const bytes = readFileSync(source);
    const forbidden = path.startsWith('libexec/') ? [root, 'native/.build', 'native/.dependencies'] : [root];
    assert(!forbidden.some(value => bytes.includes(Buffer.from(value))),
      `Developer path in package input: ${path}`);
    mkdirSync(dirname(join(staging, path)), { recursive: true });
    copyFileSync(source, join(staging, path));
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  });
  chmodSync(join(staging, 'dist/cli/main.js'), 0o755);
  return { target, files, buildLockSHA256: hash(readFileSync(join(root, 'package-lock.json'))),
    nativeLinkage: JSON.parse(readFileSync(join(root, `libexec/${target}/linkage.json`))) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [destination, ...extra] = process.argv.slice(2);
  assert(destination && isAbsolute(destination) && !extra.length, 'Usage: package-local.mjs <absolute-output-directory>');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const staging = join(destination, 'package-input');
  const staged = stagePackage(staging);
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: staging, encoding: 'utf8' }));
  assert.equal(packed.length, 1);
  assert.deepEqual(packed[0].files.map(file => file.path).sort(), staged.files.map(file => file.path));
  const archive = readFileSync(join(destination, packed[0].filename));
  const receipt = { schemaVersion: 1, ...staged, filename: packed[0].filename, bytes: archive.length, sha256: hash(archive) };
  writeFileSync(join(destination, 'inventory.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ filename: join(destination, receipt.filename), sha256: receipt.sha256, bytes: receipt.bytes, files: staged.files.length }));
}
