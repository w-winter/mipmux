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
        try self.init(text: input.text("text"), pattern: input.text("pattern"),
                      caseSensitive: input.boolean("caseSensitive"), wholeWord: input.boolean("wholeWord"),
                      countOnly: input.boolean("countOnly"), limit: input.integer("limit"))
    }

    init(text: String, pattern: String, caseSensitive: Bool, wholeWord: Bool, countOnly: Bool, limit: Int) {
        self.text = text; self.pattern = pattern; self.caseSensitive = caseSensitive
        self.wholeWord = wholeWord; self.countOnly = countOnly; self.limit = limit
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
