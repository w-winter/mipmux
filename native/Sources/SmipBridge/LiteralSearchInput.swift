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
        text = try input.text("text")
        pattern = try input.text("pattern")
        guard !pattern.isEmpty else { throw BridgeFailure("nativeProtocolError") }
        caseSensitive = try input.boolean("caseSensitive")
        wholeWord = try input.boolean("wholeWord")
        countOnly = try input.boolean("countOnly")
        limit = try input.integer("limit")
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
            return ["kind": "literalSearchError", "message": error.localizedDescription]
        } catch let error as PCRE2Error {
            return ["kind": "literalSearchError", "message":
                RepoPromptPCRE2Adapter.searchPatternError(from: error, pattern: pattern).localizedDescription]
        }
    }
}
