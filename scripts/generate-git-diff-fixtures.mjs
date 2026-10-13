import { readFileSync, writeFileSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-git-diff-fixtures.mjs <pinned-rpce-checkout>');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-git-diff/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== provenance.sourceRevision) throw new Error('Reference revision differs.');
const sources = provenance.sources.map(entry => {
  const bytes = readFileSync(resolve(checkout, entry.path));
  if (hash(bytes) !== entry.sha256) throw new Error('Modified reference source: ' + entry.path);
  return bytes.toString().split('\n');
});
const lines = (source, start, end) => sources[source].slice(start - 1, end).join('\n');
const projection = [lines(1, 97, 155), lines(1, 332, 347), lines(1, 369, 400), lines(1, 440, 479)].join('\n');
const text = `import Foundation
enum MCPWindowToolName { static let git = "git" }
enum MCPProviderProjectionWorker { static func run<T>(toolName: String, phase: String, work: () -> T) async throws -> T { work() } }
enum EditFlowPerf {
    enum Stage { enum Git { static let dtoConstruction = "dto"; static let hunkParsing = "hunk" } }
    struct Dimensions { init(fileBytes: Int = 0, lineCount: Int = 0, chunkCount: Int = 0) {} }
    static func begin(_ stage: String, _ dimensions: Dimensions = Dimensions()) -> Int? { nil }
    static func end(_ stage: String, _ state: Int?, _ dimensions: Dimensions = Dimensions()) {}
}
${sources[0].join('\n').replaceAll('public ', '')}
${sources[7].join('\n').replaceAll('package ', '')}
${lines(6, 78, 157).replaceAll('package ', '')}
}
${lines(3, 70, 96).replaceAll('public ', '')}
${sources[4].join('\n').replaceAll('package ', '').replace('import RepoPromptFileSystem\n', '')}
struct Reply {
${lines(2, 2319, 2365)}
}
struct Projection {
${projection.replaceAll('@MainActor\n', '').replaceAll('private nonisolated ', '')}
}
struct File: Codable { let path: String; let status: String; let additions: Int?; let deletions: Int? }
struct Input: Codable {
    let kind: String
    let raw: String?
    let compare: String?
    let detail: String?
    let pathspecCount: Int?
    let isMultiRepo: Bool?
    let changedFiles: [File]?
    let perFilePatches: [String: String]?
    let paths: [String]?
    let repoRootPath: String?
}
struct Fixture: Codable { let name: String; let input: Input }
let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
var output: [[String: Any]] = []
for entry in cases {
    let result: [String: Any]
    if entry.input.kind == "parseGitComparison" {
        let comparison = GitDiffCompareSpec.parse(entry.input.raw)
        result = ["kind": "gitComparison", "comparison": try JSONSerialization.jsonObject(with: JSONEncoder().encode(comparison)),
            "rawKey": comparison.rawKey, "display": comparison.displayString]
    } else if entry.input.kind == "normalizeGitDiffPaths" {
        let paths = entry.input.paths!
        let root = entry.input.repoRootPath!
        result = ["kind": "gitDiffPaths", "paths": GitDiffPathNormalization.gitPathspecs(from: paths, repoRootPath: root),
            "pathspecs": GitDiffPathNormalization.gitDiscoveryPathspecs(from: paths, repoRootPath: root)]
    } else {
        let pathCount = entry.input.pathspecCount!
        let isMultiRepo = entry.input.isMultiRepo!
        let detail = entry.input.detail!.lowercased()
        let effectiveDetail: String = if pathCount == 1, detail == "summary", !isMultiRepo {
            "patches"
        } else {
            detail
        }
        let maxLinesForPatches: Int = effectiveDetail == "full" ? Int.max : 300
        let changedFiles = entry.input.changedFiles!.map { VCSUncommittedFile(path: $0.path, status: $0.status, additions: $0.additions, deletions: $0.deletions) }
        let dto = try await Projection.makeDiffDTO(compare: entry.input.compare!, detail: effectiveDetail, changedFiles: changedFiles,
            perFilePatches: entry.input.perFilePatches, maxLinesForPatches: maxLinesForPatches)
        result = ["kind": "gitDiff", "diff": try JSONSerialization.jsonObject(with: JSONEncoder().encode(dto))]
    }
    output.append(["name": entry.name, "result": result])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
`;
const scratch = mkdtempSync(join(tmpdir(), 'smip-git-diff-reference-'));
writeFileSync(scratch + '/reference.swift', text);
execFileSync('swiftc', [scratch + '/reference.swift', '-o', scratch + '/reference'], { stdio: 'inherit' });
const input = openSync(directory + 'cases.json', 'r'), output = openSync(scratch + '/output.json', 'w');
try { execFileSync(scratch + '/reference', [], { stdio: [input, output, 'inherit'] }); }
finally { closeSync(input); closeSync(output); }
const inputs = JSON.parse(readFileSync(directory + 'cases.json'));
const results = JSON.parse(readFileSync(scratch + '/output.json'));
writeFileSync(directory + 'cases.json', JSON.stringify(results.map((entry, index) => ({ ...inputs[index], expected: entry.result })), null, 2) + '\n');
provenance.cases = results.length; provenance.generatorSHA256 = hash(text);
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ cases: results.length, scratch }));
