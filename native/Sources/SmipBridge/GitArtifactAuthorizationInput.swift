import Foundation

struct GitArtifactAuthorizationInput {
    private struct Checkout: Decodable {
        let checkoutRootPath: String
        let repoKey: String
        let kind: String
    }

    private struct Input: Decodable {
        let manifest: String
        let snapshotDir: String
        let path: String
        let ownerID: UUID
        let checkout: Checkout
    }

    private let input: Input

    init(_ value: Any) throws {
        _ = try WireObject(value, keys: ["kind", "manifest", "snapshotDir", "path", "ownerID", "checkout"])
        input = try JSONDecoder().decode(Input.self, from: JSONSerialization.data(withJSONObject: value))
    }

    func render() throws -> [String: Any] {
        guard let bytes = Data(base64Encoded: input.manifest) else { throw BridgeFailure("nativeProtocolError") }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let manifest = try? decoder.decode(GitDiffSnapshotManifest.self, from: bytes),
              let ref = GitDiffSnapshotStore().parseSnapshotRef(input.snapshotDir),
              ref.repoKey == manifest.repoKey,
              manifest.snapshotID == ref.snapshotID,
              GitDiffSnapshotStore.normalizeSnapshotID(manifest.snapshotID) == manifest.snapshotID,
              ref.repoKey == input.checkout.repoKey,
              let root = manifest.repoRoot,
              StandardizedPath.absolute(root) == input.checkout.checkoutRootPath,
              (input.checkout.kind == "linkedWorktree") == (manifest.isWorktree == true),
              manifest.tabID == input.ownerID,
              checkoutMatches(manifest)
        else { return result(false) }
        let allowed: Bool
        if input.path == "MAP.txt" || input.path == "diff/all.patch" {
            allowed = true
        } else {
            allowed = manifest.files.contains { file in
                file.patchPath.flatMap(GitDiffArtifactPathPolicy.safeManifestPatchPath) == input.path
            }
        }
        return result(allowed)
    }

    private func checkoutMatches(_ manifest: GitDiffSnapshotManifest) -> Bool {
        guard let layout = GitRepositoryLayoutResolver.resolve(
            atWorkTreeRoot: URL(fileURLWithPath: input.checkout.checkoutRootPath)
        ) else { return false }
        let commonDirectoryPath = StandardizedPath.absolute(layout.commonDir.path)
        let hasWorktreeMetadata = manifest.isWorktree == true || manifest.worktreeName != nil ||
            manifest.worktreeRoot != nil || manifest.mainWorktreeRoot != nil || manifest.commonGitDir != nil
        if input.checkout.kind == "linkedWorktree" || hasWorktreeMetadata || layout.isLinkedWorktree {
            guard manifest.isWorktree == true, layout.isLinkedWorktree,
                  manifest.worktreeRoot.map(StandardizedPath.absolute) == input.checkout.checkoutRootPath,
                  manifest.commonGitDir.map(StandardizedPath.absolute) == commonDirectoryPath
            else { return false }
        } else if layout.isLinkedWorktree { return false }
        return true
    }

    private func result(_ authorized: Bool) -> [String: Any] {
        ["kind": "gitArtifactAuthorization", "authorized": authorized]
    }
}
