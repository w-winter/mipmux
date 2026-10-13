// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

extension GitDiffSnapshotStore {
    struct GitDiffSnapshotRef: Hashable {
        let repoKey: String
        let snapshotID: String

        var snapshotDirRel: String {
            "repos/\(repoKey)/\(snapshotID)"
        }
    }

    func parseSnapshotRef(_ raw: String) -> GitDiffSnapshotRef? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let parts = trimmed.split(separator: "/").map(String.init)
        guard parts.count >= 3, parts.first == "repos" else { return nil }
        let repoKey = parts[1]
        let snapshotID = parts.dropFirst(2).joined(separator: "/")
        guard let normalized = Self.normalizeSnapshotID(snapshotID) else { return nil }
        return GitDiffSnapshotRef(repoKey: repoKey, snapshotID: normalized)
    }
}
