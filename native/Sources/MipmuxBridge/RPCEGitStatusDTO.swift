// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: scope the source DTO to its native status owner.
// Preserve the source DTO and its CodingKeys inside the native owner.
// swiftlint:disable nesting
import Foundation

extension RPCEGitStatus {
    struct StatusDTO: Codable, Equatable {
        let branch: String?
        let upstream: String?
        let ahead: Int?
        let behind: Int?
        let staged: [String]
        let modified: [String]
        let untracked: [String]
        let summary: String

        private enum CodingKeys: String, CodingKey {
            case branch, upstream, ahead, behind, staged, modified, untracked, summary
        }
    }
}

// swiftlint:enable nesting
