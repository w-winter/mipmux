// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
import Foundation

// Modified: declarations are executable-local. CodeMapUsage is already retained.
enum FileTreeOption: String, CaseIterable, Identifiable, Codable {
    case auto = "Auto"
    case files = "Full"
    case selected = "Selected"
    case none = "None"

    var id: String {
        rawValue
    }
}

enum GitInclusion: String, Codable, CaseIterable {
    case none
    case selected
    case complete
}
