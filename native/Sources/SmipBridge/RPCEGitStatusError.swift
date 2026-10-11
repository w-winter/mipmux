// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: retain the source parse-error variant and its diagnostic text.
import Foundation

enum VCSError: LocalizedError {
    case parseError(message: String)

    var errorDescription: String? {
        switch self {
        case let .parseError(message):
            "Failed to parse VCS output: \(message)"
        }
    }
}
