import Foundation
import RepoPromptRegexCore

struct RegexCompilationInput {
    private let pattern: String
    private let caseSensitive: Bool
    private let wholeWord: Bool

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "pattern", "caseSensitive", "wholeWord"])
        pattern = try input.text("pattern")
        caseSensitive = try input.boolean("caseSensitive")
        wholeWord = try input.boolean("wholeWord")
    }

    func render() throws -> [String: Any] {
        do {
            try RegexToolkit.validateComplexity(pattern, isRegex: true)
            var corrected: Bool?
            _ = try RPCESearchRegex.compilePrimaryEngine(pattern: pattern, caseInsensitive: !caseSensitive,
                                                         wholeWord: wholeWord, wasAutoCorrected: &corrected)
            let correction: [String: Any] = corrected == true
                ? ["kind": "corrected", "warning": RPCESearchWarning.searchAutoCorrectionWarning(isRegex: true)]
                : ["kind": "unchanged"]
            return ["kind": "regexCompilation", "correction": correction]
        } catch let error as RegexPatternFailure {
            return ["kind": "regexSearchError", "message": error.localizedDescription]
        } catch let error as PCRE2Error {
            return ["kind": "regexSearchError", "message":
                RepoPromptPCRE2Adapter.searchPatternError(from: error, pattern: pattern).localizedDescription]
        }
    }
}
