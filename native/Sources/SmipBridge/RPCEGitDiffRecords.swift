// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: internal visibility in the headless native target.
import Foundation

struct VCSUncommittedFile: Equatable {
    /// The path of the file relative to the repository root.
    let path: String

    /// The status code of the file.
    /// Common values: "M" (modified), "A" (added), "D" (deleted), "R" (renamed),
    /// "C" (copied), "U" (unmerged), "??" (untracked, git only)
    let status: String

    /// Number of lines added (nil for binary files or when stats unavailable).
    let additions: Int?

    /// Number of lines deleted (nil for binary files or when stats unavailable).
    let deletions: Int?

    init(
        path: String,
        status: String,
        additions: Int? = nil,
        deletions: Int? = nil
    ) {
        self.path = path
        self.status = status
        self.additions = additions
        self.deletions = deletions
    }
}

struct VCSCommitInfo {
    /// The full commit/change ID.
    let id: String

    /// The short commit/change ID.
    let shortID: String

    /// The author name.
    let author: String

    /// The commit date in ISO8601 format.
    let dateISO: String

    /// The full commit message.
    let message: String
}
