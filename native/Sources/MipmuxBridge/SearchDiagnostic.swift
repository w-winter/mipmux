import Foundation
import RepoPromptRegexCore

enum SearchDiagnostic {
    static func render(_ error: RegexPatternFailure, pattern: String, isRegex: Bool) -> [String: Any] {
        guard let error = error as? SearchPatternError else {
            return ["kind": "rejected", "message": error.localizedDescription]
        }
        let parts = SearchPatternErrorFormatter.parts(for: pattern, isRegex: isRegex, error: error)
        let suggestion = parts.suggestion.map {
            $0.replacingOccurrences(of: "regex=true", with: "query.kind=\"regex\"")
                .replacingOccurrences(of: "regex=false", with: "query.kind=\"literal\"")
        }
        return ["kind": "pattern", "issue": parts.issue, "suggestion": suggestion as Any? ?? NSNull()]
    }
}
