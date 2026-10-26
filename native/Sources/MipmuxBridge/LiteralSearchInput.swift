import Foundation
import RepoPromptRegexCore

struct LiteralSearchInput {
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

    init(text: String, pattern: String, caseSensitive: Bool, wholeWord: Bool, countOnly: Bool, limit: Int) throws {
        guard !pattern.isEmpty else { throw BridgeFailure("nativeProtocolError") }
        self.text = text; self.pattern = pattern; self.caseSensitive = caseSensitive
        self.wholeWord = wholeWord; self.countOnly = countOnly; self.limit = limit
    }

    func render() throws -> [String: Any] {
        do {
            try RegexToolkit.validateComplexity(pattern, isRegex: false)
            try Task.checkCancellation()
            let counted = countOnly ? try RPCESearchRegex.scanLiteralCountOnlyFastPath(
                pattern, in: text, caseInsensitive: !caseSensitive, wholeWord: wholeWord, fuzzySpaceMatching: true
            ) : nil
            let result = try counted ?? RPCESearchRegex.scanLiteral(
                pattern, in: RPCESearchRegex.SearchDocument(text: text, lineIndex: .init(content: text)),
                caseInsensitive: !caseSensitive, wholeWord: wholeWord, fuzzySpaceMatching: true,
                countOnly: countOnly, maxCollectedMatches: countOnly ? nil : max(0, limit)
            )
            return ["kind": "literalSearch", "matches": result.hits.map { $0.lineNumber + 1 },
                    "matchingLines": countOnly ? result.lineMatchCount : result.hits.count]
        } catch let error as RegexPatternFailure {
            return ["kind": "literalSearchError",
                    "diagnostic": SearchDiagnostic.render(error, pattern: pattern, isRegex: false)]
        } catch let error as PCRE2Error {
            return ["kind": "literalSearchError", "diagnostic": SearchDiagnostic.render(
                RepoPromptPCRE2Adapter.searchPatternError(from: error, pattern: pattern),
                pattern: pattern, isRegex: false
            )]
        }
    }
}
