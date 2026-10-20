import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [checkout] = process.argv.slice(2);
assert(checkout && process.platform === 'darwin', 'Usage on macOS: node scripts/generate-decoding-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), revision);
const path = 'test/fixtures/rpce-decoding/';
const provenance = JSON.parse(readFileSync(path + 'provenance.json', 'utf8'));
const source = readFileSync(resolve(checkout, 'Sources/RepoPromptFileSystem/FileSystemService+ContentLoading.swift'));
assert.equal(createHash('sha256').update(source).digest('hex'), provenance.sourceSHA256);
const decoder = source.toString().split('\n').slice(7, 51).join('\n').replace('package func ', 'func ');
const run = mkdtempSync(join(tmpdir(), 'mipmux-decoding-reference-'));
try {
  mkdirSync(join(run, 'Sources/ReferenceDecoder'), { recursive: true });
  writeFileSync(join(run, 'Package.swift'), `// swift-tools-version: 6.2
import PackageDescription
let package = Package(name: "DecoderReference",
    dependencies: [.package(path: ${JSON.stringify(resolve(checkout, 'Vendor/UniversalCharsetDetection'))})],
    targets: [.executableTarget(name: "ReferenceDecoder",
        dependencies: [.product(name: "UniversalCharsetDetection", package: "UniversalCharsetDetection")])],
    swiftLanguageModes: [.v5])
`);
  const program = `import Foundation
import UniversalCharsetDetection
${decoder}
struct DetectedText { let string: String; let encoding: String.Encoding }
struct Input: Decodable { let name: String; let base64: String }
let inputs = try JSONDecoder().decode([Input].self, from: FileHandle.standardInput.readDataToEndOfFile())
let output: [[String: Any]] = inputs.map { input in
    let data = Data(base64Encoded: input.base64)!
    let result = decodeWorkspaceAutomaticV1(data)
    let primary = data.isEmpty || String(data: data, encoding: .utf8) != nil
    let linuxText = !primary && data.detectedCharacterEncoding == nil ? nil : result?.string
    return ["name": input.name, "base64": input.base64,
            "expected": result?.string as Any? ?? NSNull(), "linuxExpected": linuxText as Any? ?? NSNull()]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]))
`;
  writeFileSync(join(run, 'Sources/ReferenceDecoder/main.swift'), program);
  execFileSync('swift', ['build', '--package-path', run, '--product', 'ReferenceDecoder'], { stdio: 'inherit' });
  const output = execFileSync(join(run, '.build/debug/ReferenceDecoder'), [], { input: readFileSync(path + 'cases.json') });
  writeFileSync(path + 'cases.json', output.toString() + '\n');
  provenance.generator = 'scripts/generate-decoding-fixtures.mjs';
  provenance.command = 'node scripts/generate-decoding-fixtures.mjs <pinned-rpce-checkout>';
  provenance.generatorSHA256 = createHash('sha256').update(program).digest('hex');
  delete provenance.capturedInputsAndProgram;
  writeFileSync(path + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
} finally {
  execFileSync('/usr/bin/trash', [run]);
}
