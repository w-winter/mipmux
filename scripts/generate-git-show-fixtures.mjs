import { readReferenceSource, runReference } from './reference-harness.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-git-show-fixtures.mjs <pinned-rpce-checkout>');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-git-show/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== provenance.sourceRevision) throw new Error('Reference revision differs.');
const sources = provenance.sources.map(entry => {
  const bytes = readReferenceSource(checkout, entry);
  return bytes.toString().split('\n');
});
const lines = (source, start, end) => sources[source].slice(start - 1, end).join('\n');
const projection = lines(1, 41, 75) + '\n' + lines(1, 332, 339) + '\n' + lines(1, 373, 438);
const text = `import Foundation
struct GitError: Error { let message: String }
enum GitDiffCompareSpec { case staged(String), stagedMergeBase(String), uncommitted(String), uncommittedMergeBase(String), unstaged, revspec(String) }
enum MCPToolWorkCountDiagnostics { static func measureGitParse<T>(_ work: () -> T) -> T { work() } }
enum MCPWindowToolName { static let git = "git" }
enum MCPProviderProjectionWorker { static func run<T>(toolName: String, phase: String, work: () -> T) async throws -> T { work() } }
enum EditFlowPerf {
    enum Stage { enum Git { static let dtoConstruction = "dto"; static let hunkParsing = "hunk" } }
    struct Dimensions { init(fileBytes: Int = 0, lineCount: Int = 0, chunkCount: Int = 0) {} }
    static func begin(_ stage: String, _ dimensions: Dimensions = Dimensions()) -> Int? { nil }
    static func end(_ stage: String, _ state: Int?, _ dimensions: Dimensions = Dimensions()) {}
}
${lines(3, 70, 96).replaceAll('public ', '')}
${lines(3, 326, 355).replaceAll('public ', '')}
${sources[4].join('\n').replaceAll('package ', '').replace('import RepoPromptFileSystem\n', '')}
struct Reply {
${lines(2, 2336, 2365)}
${lines(2, 2388, 2402)}
}
struct Projection {
${projection.replaceAll('@MainActor\n', '').replaceAll('private nonisolated ', '')}
}
struct Input: Codable { let ref: String; let detail: String; let contextLines: Int; let detectRenames: Bool }
struct Fixture: Codable { let name: String; let input: Input; let metadata: String; let numstat: String; let nameStatus: String; let patch: String }
final class GitService {
    typealias UncommittedFile = VCSUncommittedFile
    let entry: Fixture
    var commands: [[String]] = []
    init(_ entry: Fixture) { self.entry = entry }
    func runGit(_ args: [String], at _: URL) async throws -> (String, String, Int32) {
        commands.append(args)
        let output = args[0] == "show" ? entry.metadata : args.contains("--numstat") ? entry.numstat : args.contains("--name-status") ? entry.nameStatus : entry.patch
        return (output, "", 0)
    }
    func getUntrackedPaths(paths: [String]?, at: URL) throws -> [String] { fatalError("Show cannot request untracked paths") }
    func pruneUntrackedStats(at: URL, paths: Set<String>?) { fatalError("Show cannot prune untracked stats") }
    func untrackedLineStats(for: String, repoURL: URL) -> (additions: Int?, deletions: Int?) { fatalError("Show cannot count untracked lines") }
${lines(0, 2845, 3078)}
${lines(0, 3181, 3188)}
        let cleanedPaths = (paths ?? []).filter { !$0.isEmpty }
${lines(0, 3195, 3206)}
${lines(0, 3241, 3251)}
    }
${lines(0, 3358, 3373)}
${lines(0, 3833, 3982)}
${lines(0, 7249, 7286)}
${lines(0, 8798, 8885)}
}
let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
var output: [[String: Any]] = []
for entry in cases {
    let service = GitService(entry)
    let ref = entry.input.ref.trimmingCharacters(in: .whitespacesAndNewlines)
    let rawDetail = entry.input.detail.lowercased()
    let detail = rawDetail == "patches" ? "full" : rawDetail
    let repository = URL(fileURLWithPath: "/")
    let result: [String: Any]
    do {
        let info = try await service.commitInfo(ref: ref, at: repository)
        let changedFiles = try await service.getChangedFilesStats(compare: .revspec(ref + "^!"), includeUntrackedWhenApplicable: false, detectRenames: entry.input.detectRenames, at: repository)
        let diffText = detail == "full" ? try await service.getDiffRevspec(ref + "^!", paths: nil, contextLines: entry.input.contextLines, detectRenames: entry.input.detectRenames, at: repository) : nil
        let show = try await Projection.makeShowDTO(commitInfo: VCSCommitInfo(id: info.sha, shortID: info.shortSHA, author: info.author, dateISO: info.dateISO, message: info.message), changedFiles: changedFiles, detail: detail, diffText: diffText)
        result = ["kind": "gitShow", "show": try JSONSerialization.jsonObject(with: JSONEncoder().encode(show))]
    } catch let error as GitError { result = ["kind": "gitShowError", "message": error.message] }
    output.append(["name": entry.name, "commands": service.commands, "result": result])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
`;
const referenceOutput = runReference(text, readFileSync(directory + 'cases.json'));
const inputs = JSON.parse(readFileSync(directory + 'cases.json'));
const results = JSON.parse(referenceOutput);
writeFileSync(directory + 'cases.json', JSON.stringify(results.map((entry, index) => ({ ...inputs[index], expectedCommands: entry.commands, expected: entry.result })), null, 2) + '\n');
provenance.cases = results.length; provenance.generatorSHA256 = hash(text);
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ cases: results.length }));
