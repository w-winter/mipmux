import { withReferenceDirectory } from './reference-harness.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [checkout] = process.argv.slice(2);
assert(checkout, 'Usage: node scripts/generate-ask-user-fixtures.mjs <pinned-rpce-checkout>');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-ask-user/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), provenance.sourceRevision);
const sources = provenance.sources.map(entry => {
  const bytes = readFileSync(resolve(checkout, entry.path));
  assert.equal(hash(bytes), entry.sha256, 'Modified RPCE source: ' + entry.path);
  assert.equal(execFileSync('git', ['-C', checkout, 'hash-object', entry.path], { encoding: 'utf8' }).trim(),
    execFileSync('git', ['-C', checkout, 'rev-parse', provenance.sourceRevision + ':' + entry.path], { encoding: 'utf8' }).trim());
  const lines = bytes.toString().split('\n');
  return entry.ranges.map(([first, last]) => lines.slice(first - 1, last).join('\n')).join('\n');
});
const adapter = provenance.adapters.map(entry => {
  const bytes = readFileSync(entry.path);
  assert.equal(hash(bytes), entry.sha256, 'Modified reference adapter: ' + entry.path);
  return bytes.toString();
});
const decoder = provenance.valueDecoderSources.map(entry => {
  const bytes = readFileSync(entry.path);
  assert.equal(hash(bytes), entry.sha256, 'Modified retained MCP decoder: ' + entry.path);
  return bytes.toString();
}).join('\n');
const bridge = sources[2].replace('private static func questions(', 'static func questions(')
  .replace('private static func skippedResponse(', 'static func skippedResponse(')
  .replace('private static func message(', 'static func message(');
const text = `import Foundation
${adapter[0]}
${decoder}
${adapter[1]}
${sources[0]}
enum MCPAskUserToolProvider {
${sources[1]}
}
enum MCPAskUserElicitationBridge {
${bridge}
}
${adapter[2]}
let inputs = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
let output = try inputs.map { entry -> [String: Any] in
    ["name": entry["name"]!, "input": entry["input"]!, "expected": try AskUserInput(entry["input"]!).render()]
}
let bytes = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
FileHandle.standardOutput.write(bytes)
`;
withReferenceDirectory('mipmux-ask-user-reference-', scratch => {
  writeFileSync(join(scratch, 'main.swift'), text);
  execFileSync('swiftc', ['-swift-version', '6', join(scratch, 'main.swift'), '-o', join(scratch, 'reference')], { stdio: 'inherit' });
  const input = openSync(directory + 'cases.json', 'r'), output = openSync(join(scratch, 'outputs.json'), 'w');
  try { execFileSync(join(scratch, 'reference'), [], { stdio: [input, output, 'inherit'] }); }
  finally { closeSync(input); closeSync(output); }
  const bytes = readFileSync(join(scratch, 'outputs.json'));
  writeFileSync(directory + 'cases.json', bytes.toString() + '\n');
  provenance.generatorSHA256 = hash(text);
  provenance.outputSHA256 = hash(bytes);
  writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
  console.log(JSON.stringify({ cases: JSON.parse(bytes).length, outputSHA256: hash(bytes) }));
});
