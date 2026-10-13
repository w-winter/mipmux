import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
const repository = resolve(process.argv[2]);
const clock = 1700000000;
const sources = ['Models/GitDiffPublishMode.swift', 'Models/GitDiffScope.swift', 'Models/GitDiffFingerprint.swift',
  'Models/GitDiffSnapshotManifest.swift', 'GitDiffPrimaryArtifacts.swift', 'GitDiffPatchParsing.swift',
  'GitDiffSnapshotStore.swift', 'GitDiffDataMaintenance.swift'].map(path => {
  const source = 'Sources/RepoPromptVCS/GitDiff/' + path;
  const bytes = execFileSync('git', ['-C', repository, 'show', `${revision}:${source}`]);
  return { source, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const layoutPath = 'Sources/RepoPromptVCS/GitRepositoryLayout.swift';
const layout = execFileSync('git', ['-C', repository, 'show', `${revision}:${layoutPath}`]);
const ownerA = '11111111-1111-4111-8111-111111111111', ownerB = '22222222-2222-4222-8222-222222222222';
const rows = count => Array.from({ length: count }, (_, index) => ({ repoKey: index % 2 ? 'b' : 'a',
  snapshotID: `dated/${String(index).padStart(2, '0')}`, generatedAt: clock - count + index, tabID: null }));
const cases = [
  { name: 'publish-count', operation: { kind: 'published' }, entries: rows(26) },
  { name: 'publish-ties', operation: { kind: 'published' }, entries: rows(26).map(row => ({ ...row, generatedAt: clock })) },
  { name: 'publish-keeps-old-age', operation: { kind: 'published' }, entries: rows(2).map(row => ({ ...row, generatedAt: clock - 8 * 86400 })) },
  { name: 'open-age', operation: { kind: 'opened', lastCleanupAt: clock - 7 * 3600 }, entries: [
    { repoKey: 'a', snapshotID: 'dated/old', generatedAt: clock - 8 * 86400, tabID: null },
    { repoKey: 'a', snapshotID: 'dated/recent', generatedAt: clock - 6 * 86400, tabID: null }] },
  { name: 'open-throttled', operation: { kind: 'opened', lastCleanupAt: clock - 5 * 3600 }, entries: [
    { repoKey: 'a', snapshotID: 'dated/old', generatedAt: clock - 8 * 86400, tabID: null }] },
  { name: 'close-batch', operation: { kind: 'closed', tabIDs: [ownerA] }, entries: rows(5).map((row, index) => ({ ...row,
    tabID: index % 2 ? ownerA : ownerB })) },
  { name: 'close-last', operation: { kind: 'closed', tabIDs: [ownerA] }, entries: [
    { repoKey: 'a', snapshotID: 'dated/only', generatedAt: clock, tabID: ownerA }] },
  { name: 'close-empty-owner-set', operation: { kind: 'closed', tabIDs: [] }, entries: rows(2) },
];
const adapter = `import Foundation
struct GitRepoDescriptor { let repoKey: String; let rootPath: String }
struct VCSUncommittedFile: Codable { let path: String; let status: String; let additions: Int?; let deletions: Int? }
struct GitDiffEngine { struct GitDiffSnapshotBuildResult { let fingerprint: GitDiffFingerprint; let changedFiles: [VCSUncommittedFile]; let summary: (files: Int, insertions: Int, deletions: Int); let diffText: String?; let perFile: [String: String]? } }
struct Entry: Decodable { let repoKey: String; let snapshotID: String; let generatedAt: Double; let tabID: UUID? }
struct Operation: Decodable { let kind: String; let lastCleanupAt: Double?; let tabIDs: [UUID]? }
struct Fixture: Decodable { let name: String; let entries: [Entry]; let operation: Operation }
`;
const main = `
@main struct Runner { static func main() async throws {
 let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
 let store = GitDiffSnapshotStore(), fm = FileManager.default
 var outputs: [[String: Any]] = []
 for entry in cases {
  let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent(entry.name)
  try fm.createDirectory(at: root, withIntermediateDirectories: true)
  let fingerprint = GitDiffFingerprint(headSHA: String(repeating: "a", count: 40), baseRef: "HEAD", statusHash: "fixture", generatedAt: Date(timeIntervalSince1970: ${clock}))
  let content = GitDiffEngine.GitDiffSnapshotBuildResult(fingerprint: fingerprint, changedFiles: [], summary: (0, 0, 0), diffText: nil, perFile: nil)
  for row in entry.entries {
   _ = try store.writeSnapshot(workspaceDirectory: root, repoKey: row.repoKey, snapshotID: row.snapshotID, mode: .quick, compareRaw: "uncommitted", compareInput: nil, scope: .all, requestedPaths: nil, fingerprint: fingerprint, contextLines: 3, detectRenames: false, inputs: content, commitGraph: "", tabID: row.tabID)
   let file = store.snapshotDir(workspaceDirectory: root, repoKey: row.repoKey, snapshotID: row.snapshotID).appendingPathComponent("manifest.json")
   guard var value = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any] else { fatalError("invalid source manifest") }
   let formatter = ISO8601DateFormatter(); value["generatedAt"] = formatter.string(from: Date(timeIntervalSince1970: row.generatedAt))
   try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: file)
   try store.writeCurrentSnapshotID(row.snapshotID, workspaceDirectory: root, repoKey: row.repoKey)
  }
  var result: [String: Any] = [:]
  switch entry.operation.kind {
  case "published":
   let published = entry.entries.last!
   await GitDiffDataMaintenance.shared.runAfterSnapshotPublish(workspaceDirectory: root, repoKey: published.repoKey, snapshotID: published.snapshotID, generatedAt: Date(timeIntervalSince1970: published.generatedAt))
  case "opened":
   let state: [String: Any] = ["version": 2, "lastCleanupAt": ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: entry.operation.lastCleanupAt!))]
   try JSONSerialization.data(withJSONObject: state).write(to: store.gitDataRoot(workspaceDirectory: root).appendingPathComponent("maintenance.json"))
   let outcome = await GitDiffDataMaintenance.shared.runOnWorkspaceOpen(workspaceDirectory: root)
   result = ["expiredDeleted": outcome.expiredSnapshotsDeleted, "excessDeleted": outcome.excessSnapshotsDeleted]
  case "closed":
   let count = await GitDiffDataMaintenance.shared.deleteSnapshotsForTabs(workspaceDirectory: root, tabIDs: Set(entry.operation.tabIDs!))
   result = ["deleted": count]
  default: fatalError("invalid fixture operation")
  }
  var remaining: [String] = [], pointers: [[String: Any]] = []
  for key in Set(entry.entries.map(\\.repoKey)).sorted() {
   remaining += try store.listSnapshotEntries(workspaceDirectory: root, repoKey: key).map { key + "/" + $0.snapshotID }
   let pointer = store.currentPointerURL(workspaceDirectory: root, repoKey: key)
   pointers.append(["repoKey": key, "readCurrent": store.readCurrentSnapshotID(workspaceDirectory: root, repoKey: key) as Any? ?? NSNull(), "link": (try? fm.destinationOfSymbolicLink(atPath: pointer.path)) as Any? ?? NSNull()])
  }
  outputs.append(["name": entry.name, "remaining": remaining.sorted(), "pointers": pointers, "result": result])
 }
 FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: outputs, options: [.sortedKeys]))
} }
`;
const adapt = bytes => bytes.toString().replaceAll('package ', '').replace('import RepoPromptFileSystem\n', '')
  .replace('import RepoPromptFoundation\n', '').replaceAll('Date()', `Date(timeIntervalSince1970: ${clock})`);
const text = adapter + sources.map(entry => {
  const body = entry.source.endsWith('GitDiffPrimaryArtifacts.swift')
    ? entry.bytes.toString().split('\n').filter((_, index) => index < 11 || index > 14).join('\n') : entry.bytes;
  return adapt(body);
}).join('\n') + adapt(layout) + main;
const scratch = mkdtempSync(join(tmpdir(), 'smip-retention-reference-'));
try {
  writeFileSync(join(scratch, 'original.swift'), text);
  execFileSync('swiftc', ['-parse-as-library', join(scratch, 'original.swift'), '-o', join(scratch, 'reference')], { stdio: 'inherit' });
  const expected = JSON.parse(execFileSync(join(scratch, 'reference'), [scratch], { input: JSON.stringify(cases) }));
  const directory = 'test/fixtures/rpce-git-retention'; mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'cases.json'), JSON.stringify(cases.map(entry => ({ ...entry, expected: expected.find(result => result.name === entry.name) })), null, 2) + '\n');
  writeFileSync(join(directory, 'provenance.json'), JSON.stringify({ sourceRevision: revision, clock, sources: [...sources,
    { source: layoutPath, sha256: createHash('sha256').update(layout).digest('hex') }].map(({ source, sha256 }) => ({ source, sha256 })),
    referenceSHA256: createHash('sha256').update(text).digest('hex'), adaptations: ['Remove package access and unavailable module imports for standalone compilation.',
      'Supply value-only diff inputs and inert repository descriptors; omit the unused primary-artifact ingress initializer.',
      'Replace Date() at the clock boundary with epoch 1700000000. Seed canonical version-2 maintenance state to exclude legacy-purge execution.',
      'Execute the original retention, store enumeration/deletion, CURRENT update, persistent index and cleanup bodies against real files.'] }, null, 2) + '\n');
  console.log(JSON.stringify({ cases: expected.length, outcomes: expected.map(entry => ({ name: entry.name, remaining: entry.remaining.length, result: entry.result })) }));
} finally { execFileSync('/usr/bin/trash', [scratch]); }
