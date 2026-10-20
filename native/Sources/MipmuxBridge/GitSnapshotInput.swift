import Foundation

struct GitSnapshotWorktree: Decodable {
    let isWorktree: Bool
    let worktreeName: String?
    let worktreeRoot: String?
    let mainWorktreeRoot: String?
    let commonGitDir: String?
}

struct GitSnapshotContent {
    let diffText: String?
    let perFile: [String: String]?
    let changedFiles: [VCSUncommittedFile]
    let summary: GitDiffSnapshotManifest.Summary
}

struct GitSnapshotInput {
    private struct File: Decodable {
        let path: String
        let status: String
        let additions: Int?
        let deletions: Int?
    }

    private struct Input: Decodable {
        let snapshotID: String
        let repoKey: String
        let mode: GitDiffPublishMode
        let scope: GitDiffScope
        let requestedPaths: [String]?
        let compare: String
        let compareInput: String?
        let diffText: String?
        let perFile: [String: String]?
        let changedFiles: [File]
        let summary: GitDiffSnapshotManifest.Summary
        let fingerprint: GitDiffFingerprint
        let contextLines: Int
        let detectRenames: Bool
        let commitGraph: String
        let repoRoot: String?
        let tabID: UUID?
        let worktree: GitSnapshotWorktree?
    }

    private let input: Input

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "input"])
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        input = try decoder.decode(Input.self, from: JSONSerialization.data(withJSONObject: fields.value("input")))
    }

    func render() throws -> [String: Any] {
        let content = GitSnapshotContent(diffText: input.diffText, perFile: input.perFile,
                                         changedFiles: input.changedFiles.map { file in
                                             VCSUncommittedFile(path: file.path, status: file.status,
                                                                additions: file.additions, deletions: file.deletions)
                                         }, summary: input.summary)
        var files: [[String: Any]] = []
        _ = try GitDiffSnapshotStore().writeSnapshot(repoKey: input.repoKey, snapshotID: input.snapshotID,
                                                     mode: input.mode, compareRaw: input.compare,
                                                     compareInput: input.compareInput, scope: input.scope,
                                                     requestedPaths: input.requestedPaths,
                                                     fingerprint: input.fingerprint,
                                                     contextLines: input.contextLines,
                                                     detectRenames: input.detectRenames,
                                                     inputs: content, commitGraph: input.commitGraph,
                                                     repoRoot: input.repoRoot, tabID: input.tabID,
                                                     metadata: input.worktree,
                                                     writeFile: { path, bytes in
                                                         files.append([
                                                             "path": path,
                                                             "bytes": bytes.base64EncodedString()
                                                         ])
                                                     })
        return ["kind": "gitSnapshotBytes", "files": files]
    }
}
