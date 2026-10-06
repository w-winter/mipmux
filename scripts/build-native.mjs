import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recipeBytes = readFileSync(join(root, 'native/pcre2-recipe.json'));
const recipe = JSON.parse(recipeBytes);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const recipeSHA256 = digest(recipeBytes);
const target = `${process.platform}-${process.arch}`;
assert(['darwin', 'linux'].includes(process.platform), 'Native builds require macOS or Linux.');
const work = join(root, 'native/.dependencies', target);
const prefix = join(work, 'prefix');
const receiptPath = join(work, 'receipt.json');
const compiler = execFileSync('cc', ['--version'], { encoding: 'utf8' });
const run = (name, args, env = process.env) => {
  process.stderr.write(`${name} ${args.map(value => JSON.stringify(value)).join(' ')}\n`);
  execFileSync(name, args, { cwd: root, env, stdio: 'inherit' });
};
const [operation, ...args] = process.argv.slice(2);
assert(['dependency', 'build', 'test', 'resolve'].includes(operation),
  'Usage: node scripts/build-native.mjs dependency|build|test|resolve [SwiftPM arguments]');
const seenOptions = new Set();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1];
  assert(!seenOptions.has(flag), `Repeated native option: ${flag}`);
  seenOptions.add(flag);
  assert(typeof value === 'string' && value.length > 0, 'Every native option requires a value.');
  assert((flag === '--configuration' && ['build', 'test'].includes(operation) && ['debug', 'release'].includes(value)) ||
    (flag === '--filter' && operation === 'test'), `Unsupported native option: ${flag}`);
}
const installedFiles = ['lib/libpcre2-8.a', 'include/pcre2.h', 'lib/pkgconfig/libpcre2-8.pc'];

if (!existsSync(receiptPath)) {
  assert(!existsSync(work), `Incomplete dependency build at ${work}; inspect it before explicitly removing it.`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const archive = join(work, 'pcre2.tar.bz2');
  const response = await fetch(recipe.archiveURL);
  assert(response.ok, `PCRE2 download returned HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(digest(bytes), recipe.archiveSHA256, 'PCRE2 archive checksum mismatch.');
  writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 });
  run('tar', ['-xjf', archive, '-C', work]);
  const source = join(work, `pcre2-${recipe.release}`);
  const sljitRoot = join(source, 'deps/sljit');
  const files = readdirSync(sljitRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(sljitRoot.length + 1)).sort();
  assert.deepEqual(files, recipe.sljitFiles.map(entry => entry.path).sort(), 'SLJIT inventory mismatch.');
  for (const file of recipe.sljitFiles) {
    const content = readFileSync(join(sljitRoot, file.path));
    const blob = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    assert.equal(blob, file.sha, `SLJIT blob mismatch: ${file.path}`);
  }
  const cmakeArgs = Object.entries(recipe.cmake).map(([name, value]) => `-D${name}=${value}`);
  if (process.platform === 'darwin') cmakeArgs.push(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${recipe.macOSDeploymentTarget}`);
  const build = join(work, 'build');
  run('cmake', ['-S', source, '-B', build, `-DCMAKE_INSTALL_PREFIX=${prefix}`, ...cmakeArgs]);
  run('cmake', ['--build', build]);
  run('ctest', ['--test-dir', build, '--output-on-failure']);
  run('cmake', ['--install', build]);
  const filesReceipt = installedFiles.map(path => ({ path, sha256: digest(readFileSync(join(prefix, path))) }));
  writeFileSync(receiptPath, JSON.stringify({
    schemaVersion: 1, target, compiler, recipeSHA256, archiveSHA256: recipe.archiveSHA256,
    files: filesReceipt,
    configuration: execFileSync(join(prefix, 'bin/pcre2test'), ['-C'], { encoding: 'utf8' }),
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
assert.equal(receipt.schemaVersion, 1, 'Unknown dependency receipt version.');
assert.equal(receipt.target, target, 'Dependency target mismatch.');
assert.equal(receipt.compiler, compiler, 'Dependency compiler changed; rebuild explicitly.');
assert.equal(receipt.recipeSHA256, recipeSHA256, 'Dependency recipe changed; rebuild explicitly.');
assert.equal(receipt.archiveSHA256, recipe.archiveSHA256, 'Dependency archive identity mismatch.');
assert.deepEqual(receipt.files.map(file => file.path), installedFiles, 'Dependency receipt inventory mismatch.');
for (const file of receipt.files) {
  assert.equal(digest(readFileSync(join(prefix, file.path))), file.sha256, `Dependency file changed: ${file.path}`);
}
assert(!readdirSync(join(prefix, 'lib')).some(name => /\.(dylib|so)(\.|$)/u.test(name)),
  'The private prefix must contain static libraries only.');
function inspectBinary(binary, symbolPath) {
  const linkedImages = execFileSync(process.platform === 'darwin' ? 'otool' : 'ldd',
    process.platform === 'darwin' ? ['-L', binary] : [binary], { encoding: 'utf8' });
  assert(!/libpcre2.*(?:dylib|\.so)/u.test(linkedImages), 'PCRE2 must be statically linked.');
  
  const symbolFile = openSync(symbolPath, 'w', 0o600);
  try { execFileSync('nm', ['-g', binary], { stdio: ['ignore', symbolFile, 'inherit'] }); }
  finally { closeSync(symbolFile); }
  const symbols = readFileSync(symbolPath, 'utf8');
  assert(/\bT _?pcre2_config_8$/mu.test(symbols), 'The width-8 PCRE2 engine must be defined in the executable.');
  const description = JSON.parse(execFileSync(binary, ['build-verification'], {
    env: { REPOPROMPT_PCRE2_JIT: 'required' }, encoding: 'utf8',
    input: JSON.stringify({ wireVersion: 1, requestId: 'describe', generation: 'build-verification', operation: { kind: 'describe' } }) + '\n',
  }));
  assert.equal(description.result.kind, 'description');
  assert.equal(description.result.engine.version, '10.49 2026-09-28');
  assert.equal(description.result.engine.unicode, recipe.unicodeVersion);
  assert.equal(description.result.engine.jitPolicy, 'required');
  assert.equal(description.result.engine.jitExecution, 'compiled');
  return { linkedImages, description };
}

if (operation !== 'dependency') {
  const expectedPins = JSON.parse(readFileSync(join(root, 'docs/vendor-provenance.json'))).dependencies;
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'native/Package.resolved'))).pins, expectedPins, 'Unexpected native dependency graph.');
  writeFileSync(join(root, 'native/Sources/SmipBridge/EngineRecipe.swift'),
    '// Generated dependency metadata by scripts/build-native.mjs.\n' +
    `enum EngineRecipe { static let canonicalBase64 = "${recipeBytes.toString('base64')}" }\n`);
  const pkgConfig = join(prefix, 'lib/pkgconfig');
  const env = { ...process.env, PKG_CONFIG_PATH: '', PKG_CONFIG_LIBDIR: pkgConfig, SMIP_PCRE2_PREFIX: prefix };
  const swiftArgs = operation === 'resolve' ? ['package', 'resolve'] : [operation];
  const sourcePathFlags = operation === 'resolve' ? [] : ['-Xcc', `-ffile-prefix-map=${join(root, 'native/.build')}=smip-native`];
  run('swift', [...swiftArgs, '--package-path', join(root, 'native'),
    '--scratch-path', join(root, 'native/.build', target), '--pkg-config-path', pkgConfig, ...sourcePathFlags, ...args], env);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'native/Package.resolved'))).pins, expectedPins, 'Native dependency resolution changed the approved graph.');
  if (operation === 'build' || operation === 'test') {
    const configurationIndex = args.indexOf('--configuration');
    const configuration = configurationIndex === -1 ? 'debug' : args[configurationIndex + 1];
    assert(['debug', 'release'].includes(configuration), 'Unsupported build configuration.');
    const directory = join(root, 'native/.build', target, configuration);
    const binary = join(directory, 'SmipBridge');
    const { linkedImages, description } = inspectBinary(binary, join(directory, 'symbols.txt'));
    writeFileSync(join(directory, 'linkage.json'), JSON.stringify({
      binarySHA256: digest(readFileSync(binary)), recipeSHA256, sourcePathFlags,
      linkedImages, description, dependencyReceipt: receipt,
    }, null, 2) + '\n');
    if (configuration === 'release') {
      const destination = join(root, 'libexec', target);
      mkdirSync(destination, { recursive: true });
      const packaged = join(destination, 'SmipBridge');
      copyFileSync(binary, packaged);
      run('strip', [process.platform === 'darwin' ? '-S' : '--strip-debug', packaged]);
      const { linkedImages: packagedImages, description: packagedDescription } = inspectBinary(packaged, join(directory, 'packaged-symbols.txt'));
      assert.deepEqual(packagedDescription, description, 'Stripping changed native preflight.');
      writeFileSync(join(destination, 'linkage.json'), JSON.stringify({
        originalBinarySHA256: digest(readFileSync(binary)), binarySHA256: digest(readFileSync(packaged)),
        recipeSHA256, sourcePathFlags, linkedImages: packagedImages, description: packagedDescription,
      }, null, 2) + '\n');
    }
  }
}
process.stderr.write(`Native dependency receipt: ${receiptPath}\n`);
