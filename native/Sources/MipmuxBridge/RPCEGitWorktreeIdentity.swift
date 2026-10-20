import Crypto

// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

public struct GitWorktreeRepositoryIdentity: Codable, Sendable, Equatable, Hashable {
    public let repositoryID: String
    public let repoKey: String
    public let displayName: String
    public let commonGitDir: String
    public let mainWorktreeRoot: String?

    public init(
        repositoryID: String,
        repoKey: String,
        displayName: String,
        commonGitDir: String,
        mainWorktreeRoot: String?
    ) {
        self.repositoryID = repositoryID
        self.repoKey = repoKey
        self.displayName = displayName
        self.commonGitDir = commonGitDir
        self.mainWorktreeRoot = mainWorktreeRoot
    }
}

/// Fresh identity resolved from the Git metadata at a worktree root.
///
/// The repository ID and key are derived from the common Git directory, while the worktree ID
/// also incorporates the per-worktree Git directory (or the explicit main-worktree marker).
/// Keeping those values together prevents a path-only resolution from becoming an authority.
public struct GitWorktreeIdentitySnapshot: Codable, Sendable, Equatable, Hashable {
    public let repository: GitWorktreeRepositoryIdentity
    public let worktreeID: String
    public let worktreeRootPath: String
    public let isMain: Bool

    public init(
        repository: GitWorktreeRepositoryIdentity,
        worktreeID: String,
        worktreeRootPath: String,
        isMain: Bool
    ) {
        self.repository = repository
        self.worktreeID = worktreeID
        self.worktreeRootPath = worktreeRootPath
        self.isMain = isMain
    }
}

package enum GitWorktreeIdentity {
    package static func repositoryIdentity(
        commonGitDir: URL,
        mainWorktreeRoot: URL?
    ) -> GitWorktreeRepositoryIdentity {
        let commonGitDirPath = standardizedPath(commonGitDir)
        let mainPath = mainWorktreeRoot.map(standardizedPath)
        let displayName: String
        if let mainWorktreeRoot {
            displayName = mainWorktreeRoot.lastPathComponent
        } else {
            let last = commonGitDir.deletingLastPathComponent().lastPathComponent
            displayName = last.isEmpty ? "repository" : last
        }
        let repoKey = makeRepoKey(for: commonGitDirPath, displayName: displayName)
        return GitWorktreeRepositoryIdentity(
            repositoryID: "gitrepo_\(sha256Hex(commonGitDirPath))",
            repoKey: repoKey,
            displayName: displayName,
            commonGitDir: commonGitDirPath,
            mainWorktreeRoot: mainPath
        )
    }

    package static func worktreeID(
        repositoryID: String,
        gitDir: URL?,
        isMain: Bool,
        path: URL
    ) -> String {
        let stableComponent: String = if isMain {
            "main"
        } else if let gitDir {
            standardizedPath(gitDir)
        } else {
            // Prunable/malformed linked worktrees may no longer have a resolvable gitdir.
            // Keep an ID available for list output; if the worktree is repaired/moved,
            // V1 treats that as a new identity.
            standardizedPath(path)
        }
        return "wt_\(sha256Hex("\(repositoryID)\u{0}\(stableComponent)"))"
    }

    package static func standardizedPath(_ url: URL) -> String {
        url.standardizedFileURL.path
    }

    private static func makeRepoKey(for path: String, displayName: String) -> String {
        "\(sanitizeSlug(displayName))-\(String(sha256Hex(path).prefix(8)))"
    }

    private static func sanitizeSlug(_ input: String) -> String {
        var slug = ""
        var lastWasHyphen = true
        for character in input.lowercased() {
            if character.isLetter || character.isNumber {
                slug.append(character)
                lastWasHyphen = false
            } else if !lastWasHyphen {
                slug.append("-")
                lastWasHyphen = true
            }
        }
        while slug.hasSuffix("-") {
            slug.removeLast()
        }
        if slug.count > 24 {
            slug = String(slug.prefix(24))
            while slug.hasSuffix("-") {
                slug.removeLast()
            }
        }
        return slug.isEmpty ? "repo" : slug
    }

    private static func sha256Hex(_ text: String) -> String {
        let digest = SHA256.hash(data: Data(text.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// Resolves repository and worktree identity directly from the current Git layout.
///
/// This deliberately performs an uncached metadata read so callers can revalidate a persisted
/// binding after a path has been replaced. Ancestors are considered for bindings to a logical
/// subdirectory inside a checkout; the returned path is always the actual checkout root.
public enum GitWorktreeIdentityResolver {
    public static func resolve(atWorkTreeRoot root: URL) -> GitWorktreeIdentitySnapshot? {
        var candidate = root.standardizedFileURL
        while true {
            if let layout = GitRepositoryLayoutResolver.resolve(atWorkTreeRoot: candidate) {
                let isMain = !layout.isLinkedWorktree
                let repository = GitWorktreeIdentity.repositoryIdentity(
                    commonGitDir: layout.commonDir,
                    mainWorktreeRoot: isMain ? layout.workTreeRoot : layout.knownMainWorktreeRoot
                )
                let worktreeID = GitWorktreeIdentity.worktreeID(
                    repositoryID: repository.repositoryID,
                    gitDir: isMain ? nil : layout.gitDir,
                    isMain: isMain,
                    path: layout.workTreeRoot
                )
                return GitWorktreeIdentitySnapshot(
                    repository: repository,
                    worktreeID: worktreeID,
                    worktreeRootPath: layout.workTreeRoot.standardizedFileURL.path,
                    isMain: isMain
                )
            }

            let parent = candidate.deletingLastPathComponent().standardizedFileURL
            guard parent.path != candidate.path else { return nil }
            candidate = parent
        }
    }
}
