import Foundation
import RepoPromptRegexCore

struct RegexSearchInput {
    private let text: String
    private let pattern: String
    private let caseSensitive: Bool
    private let wholeWord: Bool
    private let countOnly: Bool
    private let limit: Int

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: [
            "kind", "text", "pattern", "caseSensitive", "wholeWord", "countOnly", "limit"
        ])
        text = try input.text("text")
        pattern = try input.text("pattern")
        caseSensitive = try input.boolean("caseSensitive")
        wholeWord = try input.boolean("wholeWord")
        countOnly = try input.boolean("countOnly")
        limit = try input.integer("limit")
    }

    func render() throws -> [String: Any] {
        do {
            let result = try RPCESearchRegex.run(text: text, pattern: pattern, caseInsensitive: !caseSensitive,
                                                 wholeWord: wholeWord, countOnly: countOnly, limit: limit)
            return ["kind": "regexSearch", "matchingLines": countOnly ? result.lineMatchCount : result.hits.count,
                    "matches": result.hits.map { $0.lineNumber + 1 }]
        } catch let error as RegexPatternFailure {
            return ["kind": "regexSearchError",
                    "diagnostic": SearchDiagnostic.render(error, pattern: pattern, isRegex: true)]
        } catch let error as PCRE2Error {
            return ["kind": "regexSearchError", "diagnostic": SearchDiagnostic.render(
                RepoPromptPCRE2Adapter.searchPatternError(from: error, pattern: pattern),
                pattern: pattern, isRegex: true
            )]
        }
    }
}
