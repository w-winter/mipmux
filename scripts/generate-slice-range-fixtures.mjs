import { readReferenceSource, runReference } from './reference-harness.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-slice-range-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) throw new Error('Reference revision differs.');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-slice-ranges/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const source = entry => {
  const bytes = readReferenceSource(checkout, entry);
  return bytes.toString().replaceAll('package ', '');
};
const text = provenance.sources.map(source).join('\n') + `
struct Input: Codable { let kind: String; let op: String; let base: [LineRange]; let ranges: [LineRange] }
struct Fixture: Codable { let name: String; let input: Input }
let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
let output = try cases.map { entry -> [String: Any] in
    let ranges: [LineRange]
    switch entry.input.op {
    case "normalize": ranges = SliceRangeMath.normalize(entry.input.ranges)
    case "coalesce": ranges = SliceRangeMath.coalesce(entry.input.base, entry.input.ranges)
    case "subtract": ranges = SliceRangeMath.subtract(entry.input.base, removing: entry.input.ranges)
    default: fatalError("Unknown fixture operation")
    }
    let rawInput = try JSONSerialization.jsonObject(with: JSONEncoder().encode(entry.input))
    return ["name": entry.name, "input": rawInput, "expected": ranges.map { range -> [String: Any] in
        ["start": range.start, "end": range.end, "description": range.description.map { $0 as Any } ?? NSNull()]
    }]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
`;
const output = JSON.parse(runReference(text, readFileSync(directory + 'cases.json')));
// Synthesized Codable omits nil descriptions; the native wire carries explicit nulls.
for (const entry of output) for (const range of [...entry.input.base, ...entry.input.ranges]) range.description ??= null;
writeFileSync(directory + 'cases.json', JSON.stringify(output) + '\n');
provenance.cases = output.length; provenance.generatorSHA256 = createHash('sha256').update(text).digest('hex');
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ cases: output.length }));
