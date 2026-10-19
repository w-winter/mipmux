import { runReference } from './reference-harness.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-read-fixtures.mjs <pinned-rpce-checkout>');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-read/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [repo, revision] of [[checkout, provenance.sourceRevision], [checkout + '/.build/checkouts/swift-sdk', provenance.sdkRevision]]) {
  if (execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) throw new Error('Reference revision differs.');
}
const source = (entry, base = checkout) => {
  const bytes = readFileSync(resolve(base, entry.path));
  if (hash(bytes) !== entry.sha256) throw new Error('Modified reference source: ' + entry.path);
  return bytes.toString().replaceAll('package ', '');
};
const cache = source(provenance.sources[0]).split('\n');
const processor = cache.slice(18, 24).join('\n') + '\n}\n' + cache.slice(31, 46).join('\n') + '\nenum WorkspaceInteractiveReadProcessor {\n' + cache.slice(65, 134).join('\n');
const split = source(provenance.sources[1]).split('\n').slice(344, 386).join('\n');
const args = source(provenance.sources[2]).split('\n').slice(543, 549).join('\n');
const sdk = provenance.sdkSources.map(entry => source(entry, checkout + '/.build/checkouts/swift-sdk')).join('\n');
const errorSource = source(provenance.sources[3]).split('\n');
const negativeMessage = errorSource[6775].match(/invalidParams\((".*")\)/u)?.[1];
const zeroMessage = errorSource[6777].match(/invalidParams\((".*")\)/u)?.[1];
const eofMessage = source(provenance.sources[4]).split('\n')[32].match(/\? (".*")/u)?.[1];
if (!negativeMessage || !zeroMessage || !eofMessage) throw new Error('Reference read diagnostic extraction failed.');

const text = sdk + '\nimport Foundation\n' + processor + '\nextension String {\n' + split + '\n}\n' + `
struct Input: Codable { let kind: String; let text: String; let start_line: Value; let offset: Value; let limit: Value }
struct Fixture: Codable { let name: String; let input: Input }
func render(_ input: Input) throws -> [String: Any] {
    let args: [String: Value] = ["start_line": input.start_line, "offset": input.offset, "limit": input.limit]
${args}
    let prepared = WorkspaceInteractiveReadProcessor.prepare(input.text)
    do {
        let slice = try WorkspaceInteractiveReadProcessor.slice(prepared, startLine1Based: startLine1Based, lineCount: limit)
        var byteOffset = 0
        let allLines = prepared.linesWithEndings.enumerated().map { index, text -> [String: Any] in
            defer { byteOffset += text.utf8.count }
            return ["number": index + 1, "offset": byteOffset, "length": text.utf8.count, "text": text]
        }
        let lines = slice.returnedLineCount == 0 ? [] : Array(allLines[(slice.firstLine - 1)..<slice.lastLine])
        return ["kind": "readTextSlice", "content": slice.content, "totalLines": slice.totalLines,
                "firstLine": slice.firstLine, "lastLine": slice.lastLine, "returnedLineCount": slice.returnedLineCount,
                "message": slice.startExceededFileLength ? ${eofMessage} : NSNull(), "lines": lines]
    } catch WorkspaceInteractiveReadRangeError.limitWithNegativeStart {
        return ["kind": "readTextRangeError", "code": "limitWithNegativeStart", "message": ${negativeMessage}]
    } catch WorkspaceInteractiveReadRangeError.zeroStart {
        return ["kind": "readTextRangeError", "code": "zeroStart", "message": ${zeroMessage}]
    }
}
let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
let output = try cases.map { entry -> [String: Any] in
    try ["name": entry.name, "expected": render(entry.input)]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
`;
const referenceOutput = runReference(text, readFileSync(directory + 'cases.json'));
const inputs = JSON.parse(readFileSync(directory + 'cases.json'));
const results = JSON.parse(referenceOutput);
writeFileSync(directory + 'cases.json', JSON.stringify(results.map((entry, index) => ({ ...inputs[index], expected: entry.expected }))) + '\n');
provenance.cases = JSON.parse(readFileSync(directory + 'cases.json')).length;
provenance.generatorSHA256 = hash(text);
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ cases: provenance.cases }));
