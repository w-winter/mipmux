import { readReferenceSource, runReference } from './reference-harness.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-git-status-fixtures.mjs <pinned-rpce-checkout>');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-git-status/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== provenance.sourceRevision) throw new Error('Reference revision differs.');
const sources = provenance.sources.map(entry => {
  const bytes = readReferenceSource(checkout, entry);
  return bytes.toString().replaceAll('package ', '').split('\n');
});
const parser = sources[0].join('\n');
const records = sources[1].slice(129, 202).join('\n');
const vcs = sources[2].slice(227, 274).join('\n');
const service = sources[3].slice(4048, 4087).join('\n');
const formatter = sources[4].slice(328, 356).join('\n').replace('nonisolated ', '');
const dto = sources[5].slice(2303, 2317).join('\n');
const text = `import Foundation
${parser}
${records}
${vcs}
enum VCSError: LocalizedError {
    case parseError(message: String)
    var errorDescription: String? {
        switch self { case let .parseError(message): "Failed to parse VCS output: \\(message)" }
    }
}
struct GitError: Error { let message: String }
enum MCPToolWorkCountDiagnostics {
    static func measureGitParse<T>(_ body: () throws -> T) rethrows -> T { try body() }
}
enum ToolResultDTOs { enum GitToolReplyDTO {
${dto}
} }
final class Reference {
    let stdout: String
    var arguments: [String] = []
    init(_ stdout: String) { self.stdout = stdout }
    func runGit(_ args: [String], at _: URL) async throws -> (String, String, Int32) {
        arguments = args; return (stdout, "", 0)
    }
${service}
${formatter}
}
struct Fixture: Codable { let name: String; let stdout: String }
let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
var output: [[String: Any]] = []
for entry in cases {
    let reference = Reference(entry.stdout)
    let result: [String: Any]
    do {
        let status = try await reference.getRepositoryStatus(at: URL(fileURLWithPath: "/"))
        let value = VCSRepositoryStatus(branch: status.branch, headID: status.headID, upstream: status.upstream,
            ahead: status.ahead, behind: status.behind, workingStatus: VCSWorkingStatus(staged: status.workingStatus.staged,
            modified: status.workingStatus.modified, untracked: status.workingStatus.untracked))
        let data = try JSONEncoder().encode(Reference.makeStatusDTO(value))
        result = ["kind": "gitStatus", "status": try JSONSerialization.jsonObject(with: data)]
    } catch let error as VCSError {
        result = ["kind": "gitStatusError", "message": error.localizedDescription]
    }
    output.append(["name": entry.name, "arguments": reference.arguments, "result": result])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
`;
const referenceOutput = runReference(text, readFileSync(directory + 'cases.json'));
const inputs = JSON.parse(readFileSync(directory + 'cases.json'));
const results = JSON.parse(referenceOutput);
writeFileSync(directory + 'cases.json', JSON.stringify(results.map((entry, index) => ({ ...inputs[index], expectedArguments: entry.arguments, expected: entry.result })), null, 2) + '\n');
provenance.cases = results.length; provenance.generatorSHA256 = hash(text);
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ cases: results.length }));
