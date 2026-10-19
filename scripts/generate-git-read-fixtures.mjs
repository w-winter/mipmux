import { readReferenceSource, runReference } from './reference-harness.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-git-read-fixtures.mjs <pinned-rpce-checkout>');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-git-read/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== provenance.sourceRevision) throw new Error('Reference revision differs.');
const sources = provenance.sources.map(entry => {
  const bytes = readReferenceSource(checkout, entry);
  return bytes.toString().split('\n');
});
const body = [...sources[0].slice(7151, 7246), ...sources[0].slice(7287, 7374)].join('\n');
const range = sources[1].slice(1067, 1074).join('\n');
const text = `import Foundation
struct GitError: Error { let message: String }
final class Reference {
    let stdout: String
    var arguments: [String] = []
    init(_ stdout: String) { self.stdout = stdout }
    func runGit(_ args: [String], at _: URL) async throws -> (String, String, Int32) {
        arguments = args; return (stdout, "", 0)
    }
${body}
}
struct Query: Codable { let op: String; let count: Int?; let path: String?; let lines: String? }
struct Fixture: Codable { let name: String; let query: Query; let stdout: String }
let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
var output: [[String: Any]] = []
for entry in cases {
    let reference = Reference(entry.stdout)
    let result: [String: Any]
    if entry.query.op == "log" {
        let rows = try await reference.getLogSummaries(count: entry.query.count!, path: entry.query.path, at: URL(fileURLWithPath: "/"))
        result = ["kind": "gitLog", "commits": rows.map { row -> [String: Any] in
            ["sha": row.sha, "short_sha": row.shortSHA, "author": row.author, "date": row.dateISO,
             "message": row.message, "files_changed": row.filesChanged, "insertions": row.insertions, "deletions": row.deletions]
        }]
    } else {
        let args = entry.query.lines.map { ["lines": $0] } ?? [:]
${range.replace('args["lines"]?.stringValue', 'args["lines"]')}
        let rows = try await reference.blame(path: entry.query.path!, lineRange: lineRange, at: URL(fileURLWithPath: "/"))
        result = ["kind": "gitBlame", "lines": rows.map { row -> [String: Any] in
            ["num": row.line, "sha": row.sha, "author": row.author, "date": row.dateISO, "content": row.content]
        }]
    }
    output.append(["name": entry.name, "arguments": reference.arguments, "result": result])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
`;
const referenceOutput = runReference(text, readFileSync(directory + 'cases.json'));
const inputs = JSON.parse(readFileSync(directory + 'cases.json'));
const results = JSON.parse(referenceOutput);
writeFileSync(directory + 'cases.json', JSON.stringify(results.map((entry, index) => ({ ...inputs[index], expectedArguments: entry.arguments, expected: entry.result }))) + '\n');
provenance.cases = results.length; provenance.generatorSHA256 = hash(text);
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ cases: results.length }));
