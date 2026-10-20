import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-git-snapshot-fixtures.mjs <pinned-rpce-checkout>');
const repo = resolve(checkout);
const directory = resolve('test/fixtures/rpce-git-snapshot');
const fixtures = JSON.parse(readFileSync(join(directory, 'cases.json')));
const inputs = fixtures.map(({ name, input }) => ({ name, ...input }));
const files = ['Models/GitDiffPublishMode.swift', 'Models/GitDiffScope.swift', 'Models/GitDiffFingerprint.swift',
  'Models/GitDiffSnapshotManifest.swift', 'GitDiffPrimaryArtifacts.swift', 'GitDiffPatchParsing.swift', 'GitDiffSnapshotStore.swift'];
const sources = files.map(path => {
  const source = 'Sources/RepoPromptVCS/GitDiff/' + path;
  const bytes = execFileSync('git', ['-C', repo, 'show', revision + ':' + source]);
  return { source, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const adaptations = bytes => bytes.toString().replaceAll('package ', '')
  .replace('import RepoPromptFileSystem\n', '').replace('import RepoPromptFoundation\n', '');
const layouts = execFileSync('git', ['-C', repo, 'show', revision + ':Sources/RepoPromptVCS/GitRepositoryLayout.swift'], { encoding: 'utf8' });
const adapter = `import Foundation
struct GitRepoDescriptor { let repoKey: String; let rootPath: String }
struct VCSUncommittedFile: Codable { let path: String; let status: String; let additions: Int?; let deletions: Int? }
struct GitDiffEngine {
 struct GitDiffSnapshotBuildResult { let fingerprint: GitDiffFingerprint; let changedFiles: [VCSUncommittedFile]; let summary: (files: Int, insertions: Int, deletions: Int); let diffText: String?; let perFile: [String:String]? }
}
struct Fixture: Codable {
 let name: String; let mode: GitDiffPublishMode; let scope: GitDiffScope; let requestedPaths: [String]?;
 let compare: String; let compareInput: String?; let diffText: String?; let perFile: [String:String]?;
 let changedFiles: [VCSUncommittedFile]; let summary: GitDiffSnapshotManifest.Summary
}
`;
const main = `
@main struct Runner { static func main() throws {
let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
let workspace = URL(fileURLWithPath: CommandLine.arguments[1])
let store = GitDiffSnapshotStore()
let fingerprint = GitDiffFingerprint(headSHA: String(repeating: "a", count: 40), baseRef: "HEAD", statusHash: "fixture-status", generatedAt: Date(timeIntervalSince1970: 1700000000))
var outputs: [[String: Any]] = []
for entry in cases {
 do {
 let inputs = GitDiffEngine.GitDiffSnapshotBuildResult(fingerprint: fingerprint, changedFiles: entry.changedFiles, summary: (entry.summary.files, entry.summary.insertions, entry.summary.deletions), diffText: entry.diffText, perFile: entry.perFile)
 let manifest = try store.writeSnapshot(workspaceDirectory: workspace, repoKey: "fixture-repo", snapshotID: entry.name, mode: entry.mode, compareRaw: entry.compare, compareInput: entry.compareInput, scope: entry.scope, requestedPaths: entry.requestedPaths, fingerprint: fingerprint, contextLines: 3, detectRenames: false, inputs: inputs, commitGraph: "* aaaaaaa fixture\\n* bbbbbbb earlier", repoRoot: nil, tabID: UUID(uuidString: "11111111-1111-4111-8111-111111111111"))
 let snapshot = store.snapshotDir(workspaceDirectory: workspace, repoKey: "fixture-repo", snapshotID: entry.name)
 let map = try String(contentsOf: snapshot.appendingPathComponent("MAP.txt"), encoding: .utf8)
 let brief = GitDiffMapBuilder.inlineExcerpt(from: map, maxLines: 7, sections: ["SNAPSHOT_META", "CHANGED_FILE_TREE"])
 let full = GitDiffMapBuilder.inlineExcerpt(from: map, maxLines: 120)
 outputs.append(["name": entry.name, "snapshotID": manifest.snapshotID, "brief": ["text": brief.excerpt, "truncated": brief.truncated, "totalLines": brief.totalLines, "returnedLines": brief.returnedLines], "full": ["text": full.excerpt, "truncated": full.truncated, "totalLines": full.totalLines, "returnedLines": full.returnedLines]])
 } catch {
  let failure = error as NSError
  outputs.append(["name": entry.name, "failure": ["domain": failure.domain, "code": failure.code]])
 }
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: outputs, options: [.sortedKeys]))
} }
`;
const text = adapter + sources.map(entry => {
  const original = entry.source.endsWith('GitDiffPrimaryArtifacts.swift')
    ? entry.bytes.toString().split('\n').filter((_, index) => index < 11 || index > 14).join('\n')
    : entry.bytes;
  return adaptations(original);
}).join('\n') + layouts.replaceAll('package ', '') + main;
const scratch = mkdtempSync(join(tmpdir(), 'mipmux-git-snapshot-reference-'));
writeFileSync(join(scratch, 'original.swift'), text);
try {
  execFileSync('swiftc', ['-parse-as-library', join(scratch, 'original.swift'), '-o', join(scratch, 'reference')], { stdio: 'inherit' });
  const output = execFileSync(join(scratch, 'reference'), [scratch], { input: JSON.stringify(inputs) });
  const outputDirectory = join(scratch, '_git_data/repos/fixture-repo');
  const inventory = readdirSync(outputDirectory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = join(entry.parentPath, entry.name); const bytes = readFileSync(path);
    return { path: path.slice(outputDirectory.length + 1), byteCount: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const excerpts = JSON.parse(output);
  writeFileSync(join(directory, 'cases.json'), JSON.stringify(fixtures.map(fixture => ({ name: fixture.name, input: fixture.input,
    expected: inventory.filter(file => file.path.startsWith(fixture.name + '/')).map(file => ({
      path: file.path.slice(fixture.name.length + 1), bytes: readFileSync(join(outputDirectory, file.path)).toString('base64') })),
    excerpts: excerpts.find(entry => entry.name === fixture.name) })), null, 2) + '\n');
  writeFileSync(join(directory, 'provenance.json'), JSON.stringify({ sourceRevision: revision, sources: sources.map(({ source, sha256 }) => ({ source, sha256 })), adaptations: ['Remove package access and unavailable module imports for standalone reference compilation.', 'Supply value-only acquisition and inert descriptor records for filesystem-independent inputs.', 'Omit the unused published-artifact initializer at GitDiffPrimaryArtifacts.swift:12-15.', 'Keep executed snapshot writer, index, manifest and MAP policy bodies unchanged; record actual original timestamps.'], generatorSHA256: createHash('sha256').update(text).digest('hex') }, null, 2) + '\n');
  console.log(JSON.stringify({ cases: JSON.parse(output).length, files: inventory.length }));
} finally { execFileSync('/usr/bin/trash', [scratch]); }
