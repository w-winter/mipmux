// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

public enum GitDiffScope: String, Codable, Sendable {
    case selected
    case all
}
