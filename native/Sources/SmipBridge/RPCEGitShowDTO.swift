// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: scope source Git DTOs under the native projection owner.
// swiftlint:disable nesting
import Foundation

extension RPCEGitProjection {
    struct DiffFileDTO: Codable, Equatable {
        let path: String
        let status: String
        let insertions: Int?
        let deletions: Int?
        let hunks: [DiffHunkDTO]?

        private enum CodingKeys: String, CodingKey {
            case path, status, insertions, deletions, hunks
        }
    }

    struct DiffHunkDTO: Codable, Equatable {
        let header: String
        let oldStart: Int
        let newStart: Int
        let patch: String

        private enum CodingKeys: String, CodingKey {
            case header, patch
            case oldStart = "old_start"
            case newStart = "new_start"
        }
    }

    struct TotalsDTO: Codable, Equatable {
        let files: Int
        let insertions: Int
        let deletions: Int
    }

    struct ShowDTO: Codable, Equatable {
        let sha: String
        let shortSha: String
        let author: String
        let date: String
        let message: String
        let files: [DiffFileDTO]?
        let totals: TotalsDTO
        let hunks: [DiffHunkDTO]?

        private enum CodingKeys: String, CodingKey {
            case sha, author, date, message, files, totals, hunks
            case shortSha = "short_sha"
        }
    }
}

// swiftlint:enable nesting
