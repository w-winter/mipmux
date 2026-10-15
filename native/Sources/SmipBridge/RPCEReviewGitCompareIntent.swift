// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

enum ReviewGitCompareIntent: Equatable {
    case uncommittedHEAD
    case uncommittedMergeBase(symbolicBase: String)

    init(base: String?) {
        let normalized = base?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if normalized.isEmpty || normalized.caseInsensitiveCompare("HEAD") == .orderedSame {
            self = .uncommittedHEAD
        } else {
            self = .uncommittedMergeBase(symbolicBase: normalized)
        }
    }
}
