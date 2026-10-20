// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

struct RPCEGitSnapshotNaming {
    func resolveSnapshotID(override: String?, exists: (String) throws -> Bool) throws -> String {
        if let override, override.lowercased() != "auto" {
            return override
        }
        let now = Date()
        let dateFormatter = DateFormatter()
        dateFormatter.locale = Locale(identifier: "en_US_POSIX")
        dateFormatter.timeZone = TimeZone.current
        dateFormatter.dateFormat = "yyyy-MM-dd"
        let timeFormatter = DateFormatter()
        timeFormatter.locale = Locale(identifier: "en_US_POSIX")
        timeFormatter.timeZone = TimeZone.current
        timeFormatter.dateFormat = "HHmm"
        let datePart = dateFormatter.string(from: now)
        let timePart = timeFormatter.string(from: now)
        let baseID = "\(datePart)/\(timePart)"
        if try !exists(baseID) {
            return baseID
        }
        var suffix = 2
        while true {
            let candidate = "\(baseID)-\(suffix)"
            if try !exists(candidate) {
                return candidate
            }
            suffix += 1
        }
    }
}
