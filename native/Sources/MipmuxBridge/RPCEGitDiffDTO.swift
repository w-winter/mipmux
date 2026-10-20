// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: scope the source diff DTO under the native projection owner.
// swiftlint:disable nesting
import Foundation

extension RPCEGitProjection {
    struct DiffDTO: Codable, Equatable {
        let compare: String
        let detail: String?
        let files: [DiffFileDTO]?
        let totals: TotalsDTO
        let byStatus: [String: Int]?
        let oneliner: String
        let truncated: Bool?
        let truncationNote: String?

        private enum CodingKeys: String, CodingKey {
            case compare, detail, files, totals, oneliner, truncated
            case byStatus = "by_status"
            case truncationNote = "truncation_note"
        }
    }
}

// swiftlint:enable nesting
