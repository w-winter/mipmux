import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(root, path));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(read('docs/vendor-provenance.json'));
const known = new Set();
for (const file of manifest.files) {
  assert(!known.has(file.destination), `Duplicate destination: ${file.destination}`);
  known.add(file.destination);
  assert.equal(hash(read(file.destination)), file.sha256, `Modified retained source: ${file.destination}`);
  assert(/^[a-f0-9]{64}$/u.test(file.sourceSHA256));
  assert(file.ranges.every(([start, end]) => Number.isSafeInteger(start) && end >= start && start > 0));
}
for (const declaration of manifest.declarations) {
  assert(known.has(declaration.destination));
  assert(read(declaration.destination).toString().includes(declaration.name), `Missing declaration: ${declaration.name}`);
  const file = manifest.files.find(file => file.destination === declaration.destination);
  assert.equal(file.source, declaration.source);
  assert(file.ranges.some(([start, end]) => declaration.line >= start && declaration.line <= end));
}
for (const source of manifest.sourceCoverage) {
  const mappings = manifest.files.filter(file => file.source === source.source);
  for (let line = 1; line <= source.lineCount; line++) {
    if (mappings.some(file => file.ranges.some(([start, end]) => line >= start && line <= end))) continue;
    const omitted = source.omitted.find(entry => entry.line === line);
    assert(omitted && ['', '}'].includes(omitted.text.trim()), `Unmapped source line: ${source.source}:${line}`);
  }
}
const resolved = JSON.parse(read('native/Package.resolved'));
assert.deepEqual(resolved.pins, manifest.dependencies, 'Resolved native graph differs from provenance.');
assert.equal(hash(read(manifest.recipe.path)), manifest.recipe.sha256);
for (const notice of JSON.parse(read('ThirdPartyLicenses/inventory.json'))) {
  assert.equal(hash(read(notice.path)), notice.sha256, `Changed notice: ${notice.path}`);
}
const generated = new Set(manifest.generated.map(file => file.path));
const fixtures = new Set(manifest.files.filter(file => file.classification === 'fixture').map(file => file.destination));
let checked = 0;
for (const directory of ['native/Sources', 'native/Tests', 'src', 'scripts', 'test']) {
  for (const entry of readdirSync(join(root, directory), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name).slice(root.length + 1);
    if (!/\.(swift|c|h|ts|mjs|sh)$/u.test(path) || generated.has(path) || fixtures.has(path)) continue;
    const text = read(path).toString();
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    assert(lines <= 1000, `${path} exceeds 1,000 physical lines: ${lines}`);
    if (path.startsWith('native/Sources/RepoPrompt') || path.startsWith('native/Sources/CSwiftPCRE2') || path.startsWith('native/Sources/TreeSitterScannerSupport')) {
      assert(known.has(path), `Unmapped retained source: ${path}`);
    }
    checked++;
  }
}
assert(read('native/Package.swift').toString().split('\n').length <= 1001, 'Native package manifest exceeds 1,000 lines.');
console.log(JSON.stringify({ retainedFiles: known.size, mappedDeclarations: manifest.declarations.length, nativePins: resolved.pins.length, handwrittenFilesChecked: checked }));
