import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

// Test-environment prerequisite; this file is outside the npm package's files list.
const root = resolve('.');
const work = resolve('.smip-work/test-ripgrep');
const revision = 'e89fff89ac9af12e8d4ce9d5fd07beb408ca730f';
const archiveSHA256 = 'af40d0f4cb7a55994906c009a7ba865047f0d487c95bceb8db59ffc4f2173d20';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const target = `${process.platform}-${process.arch}`;
const prefix = join(root, 'native/.dependencies', target, 'prefix');
const dependencyReceipt = JSON.parse(readFileSync(join(prefix, '../receipt.json')));
for (const file of dependencyReceipt.files) assert.equal(hash(readFileSync(join(prefix, file.path))), file.sha256);
mkdirSync(work, { recursive: true, mode: 0o700 });
const response = await fetch(`https://codeload.github.com/BurntSushi/ripgrep/tar.gz/${revision}`);
assert(response.ok, `ripgrep download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(hash(bytes), archiveSHA256);
const archive = join(work, 'ripgrep.tar.gz');
writeFileSync(archive, bytes);
execFileSync('tar', ['-xzf', archive, '-C', work]);
const source = join(work, `ripgrep-${revision}`);
const env = { ...process.env, CARGO_HOME: join(work, 'cargo'), PCRE2_SYS_STATIC: '0', PKG_CONFIG_ALL_STATIC: '1',
  PKG_CONFIG_PATH: '', PKG_CONFIG_LIBDIR: join(prefix, 'lib/pkgconfig'), RUSTFLAGS: '-C link-arg=-Wl,-t' };
execFileSync('cargo', ['build', '--locked', '--release', '--features', 'pcre2', '-vv'], { cwd: source, env, stdio: ['ignore', 2, 2] });
execFileSync('cargo', ['test', '--locked', '-p', 'pcre2', '--lib'], { cwd: source, env, stdio: ['ignore', 2, 2] });
const build = join(source, 'target/release/build');
const outputs = readdirSync(build).filter(name => name.startsWith('pcre2-sys-'))
  .flatMap(name => readdirSync(join(build, name)).includes('output') ? [readFileSync(join(build, name, 'output'), 'utf8')] : []);
assert.equal(outputs.length, 1);
assert(outputs[0].includes(`cargo:rustc-link-search=native=${prefix}/lib`));
assert(outputs[0].includes('cargo:rustc-link-lib=static=pcre2-8'));
assert(!outputs[0].includes('cargo:rustc-link-lib=static=pcre2\n'));
const executable = join(source, 'target/release/rg');
const linkedImages = execFileSync(process.platform === 'darwin' ? 'otool' : 'ldd', process.platform === 'darwin' ? ['-L', executable] : [executable], { encoding: 'utf8' });
assert(!/libpcre2.*(?:dylib|\.so)/.test(linkedImages));
const symbols = execFileSync('nm', ['-g', executable], { encoding: 'utf8' });
assert(/\bT _?pcre2_config_8$/m.test(symbols));
const bindingReportedVersion = execFileSync(executable, ['--pcre2-version'], { encoding: 'utf8' });
assert.equal(execFileSync(executable, ['--pcre2', '--no-config', '--encoding', 'none', '-o', '(?<=é)🙂'], { input: 'é🙂', encoding: 'utf8' }), '🙂\n');
const metadata = execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], { cwd: source, env, encoding: 'utf8' });
const receipt = { revision, archiveSHA256, cargoLockSHA256: hash(readFileSync(join(source, 'Cargo.lock'))),
  executable, executableSHA256: hash(readFileSync(executable)), target, dependencyReceipt,
  bindingReportedVersion, linkedEngineVersion: dependencyReceipt.configuration.match(/^PCRE2 version (\S+) /mu)[1], cargoLinkDirectives: outputs[0], linkedImages,
  rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }),
  reportingLimitation: 'pcre2 0.2.11 version() returns pcre2-sys 0.2.10 binding constants. The linked version is established by the pinned private static archive and build/link evidence.' };
writeFileSync(join(work, 'cargo-metadata.json'), metadata);
writeFileSync(join(work, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
