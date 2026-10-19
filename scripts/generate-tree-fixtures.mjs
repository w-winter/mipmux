import { readReferenceSource, runReference } from './reference-harness.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-tree-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) {
  throw new Error('Reference revision differs.');
}
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-tree/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const source = entry => {
  const bytes = readReferenceSource(checkout, entry);
  return bytes.toString().split('\n').slice(entry.start - 1, entry.end).join('\n');
};
const native = name => readFileSync('native/Sources/SmipBridge/' + name, 'utf8');
const adapterRevision = '8abccaad4c3938036be31d178b3aaa6540c4cc50';
const adapter = execFileSync('git', ['show', adapterRevision + ':native/Sources/SmipBridge/FileTreeInput.swift'], { encoding: 'utf8' })
  .replace('func render() -> [String: Any]', 'func render(onlyIncludeRootsWithSelectedFiles: Bool, showCodeMapMarkers: Bool) -> [String: Any]')
  .replace('onlyIncludeRootsWithSelectedFiles: mode == "selected"', 'onlyIncludeRootsWithSelectedFiles: onlyIncludeRootsWithSelectedFiles')
  .replace('showCodeMapMarkers: true', 'showCodeMapMarkers: showCodeMapMarkers');
const wire = native('Wire.swift');
const wireStart = wire.indexOf('struct WireObject {'), wireEnd = wire.indexOf('struct SourceIdentity:');
const text = [
  'import Foundation\nimport CoreFoundation\nstruct BridgeFailure: Error { init(_ code: String) {} }',
  wire.slice(wireStart, wireEnd),
  source(provenance.sources[1]), source(provenance.sources[3]),
  'enum TokenCalculationService {\n' + source(provenance.sources[2]) + '\n}',
  source(provenance.sources[0]), adapter,
  `let raw = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
let output = try raw.map { entry -> [String: Any] in
    var input = entry["input"] as! [String: Any]
    let onlySelectedRoots = input.removeValue(forKey: "onlyIncludeRootsWithSelectedFiles") as! Bool
    let markers = input.removeValue(forKey: "showCodeMapMarkers") as! Bool
    return ["name": entry["name"]!, "input": entry["input"]!, "expected": try FileTreeInput(input).render(
        onlyIncludeRootsWithSelectedFiles: onlySelectedRoots, showCodeMapMarkers: markers)]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))`,
].join('\n\n') + '\n';
const output = runReference(text, readFileSync(directory + 'cases.json'));
writeFileSync(directory + 'cases.json', output.toString() + '\n');
provenance.cases = JSON.parse(output).length;
provenance.adapterRevision = adapterRevision;
provenance.generatorSHA256 = createHash('sha256').update(text).digest('hex');
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ cases: provenance.cases }));
