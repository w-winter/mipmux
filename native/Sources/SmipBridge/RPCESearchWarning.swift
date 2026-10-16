// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.

// swiftlint:disable line_length
enum RPCESearchWarning {
    static func searchAutoCorrectionWarning(isRegex: Bool) -> String {
        if isRegex {
            return "The content-search pattern was auto-corrected before running. Results may reflect a repaired or escaped version of the requested regex rather than the exact pattern you entered."
        }
        return "The content-search pattern was auto-corrected before running. Results may reflect a de-escaped literal interpretation of the text you entered."
    }
}

// swiftlint:enable line_length
