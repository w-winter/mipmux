// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

struct GitDiffPrimaryArtifacts: Equatable {
    let map: String
    let allPatch: String?

    var selectionCandidates: [String] {
        var paths = [map]
        if let allPatch {
            paths.append(allPatch)
        }
        return paths
    }
}

struct GitDiffPerFilePatchArtifact: Equatable {
    let jumpIndex: Int
    let gitPath: String
    let selectionPath: String
    let status: String?
    let additions: Int?
    let deletions: Int?

    init(
        jumpIndex: Int,
        gitPath: String,
        selectionPath: String,
        status: String? = nil,
        additions: Int? = nil,
        deletions: Int? = nil
    ) {
        self.jumpIndex = jumpIndex
        self.gitPath = gitPath
        self.selectionPath = selectionPath
        self.status = status
        self.additions = additions
        self.deletions = deletions
    }
}

extension GitDiffSnapshotStore {
    static func rootQualifiedArtifactPath(snapshotDir: String, relativePath: String) -> String {
        let components = ["_git_data", snapshotDir, relativePath]
            .map {
                $0.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            }
            .filter { !$0.isEmpty }
        return components.joined(separator: "/")
    }

    static func primaryArtifacts(
        snapshotDir: String,
        mapRelativePath: String = "MAP.txt",
        allPatchRelativePath: String?
    ) -> GitDiffPrimaryArtifacts {
        GitDiffPrimaryArtifacts(
            map: rootQualifiedArtifactPath(snapshotDir: snapshotDir, relativePath: mapRelativePath),
            allPatch: allPatchRelativePath.map { rootQualifiedArtifactPath(snapshotDir: snapshotDir, relativePath: $0) }
        )
    }

    static func perFilePatchArtifacts(
        snapshotDir: String,
        files: [GitDiffSnapshotManifest.FileEntry]
    ) -> [GitDiffPerFilePatchArtifact] {
        displayOrderedFiles(files).enumerated().compactMap { offset, entry in
            guard let patchPath = entry.patchPath else { return nil }
            return GitDiffPerFilePatchArtifact(
                jumpIndex: offset + 1,
                gitPath: entry.gitPath,
                selectionPath: rootQualifiedArtifactPath(snapshotDir: snapshotDir, relativePath: patchPath),
                status: entry.status,
                additions: entry.additions,
                deletions: entry.deletions
            )
        }
    }
}
