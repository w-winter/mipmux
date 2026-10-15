import Foundation
import RepoPromptRegexCore

struct SearchPatternInput {
    private let pattern: String
    private let isRegex: Bool
    private let wholeWord: Bool
    private let mode: SearchMode

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "text", "queryKind", "wholeWord", "mode"])
        pattern = try input.text("text").trimmingCharacters(in: .whitespacesAndNewlines)
        let queryKind = try input.string("queryKind")
        guard ["auto", "literal", "regex"].contains(queryKind) else { throw BridgeFailure("nativeProtocolError") }
        isRegex = queryKind == "auto" ? RPCESearchPattern.containsRegexSyntax(pattern) : queryKind == "regex"
        wholeWord = try input.boolean("wholeWord")
        guard let mode = try SearchMode(rawValue: input.string("mode")) else {
            throw BridgeFailure("nativeProtocolError")
        }
        self.mode = mode
    }

    func render() -> [String: Any] {
        guard !pattern.isEmpty else {
            let message = "pattern cannot be empty; provide a non-empty search term. " +
                "If you intend to enumerate files, use get_file_tree or specify a path mode " +
                "with a wildcard like '*.swift'."
            return ["kind": "searchPatternError", "message": message]
        }
        let fuzzy = !isRegex && pattern.contains(" ")
        let bounded = wholeWord && !fuzzy
        let contentPattern: String
        if fuzzy {
            contentPattern = RPCESearchPattern.convertSpacesToFuzzyRegex(pattern)
        } else if bounded {
            let candidate = isRegex ? pattern : RepoPromptPCRE2Adapter.escapedLiteral(pattern)
            contentPattern = "\\b\(candidate)\\b"
        } else {
            contentPattern = pattern
        }
        let effectiveMode = mode == .auto ? RPCESearchPattern.inferredAutoMode(pattern) : mode
        return ["kind": "searchPattern", "mode": effectiveMode.rawValue,
                "path": ["text": pattern, "isRegex": isRegex],
                "content": ["text": contentPattern, "isRegex": isRegex || fuzzy || bounded]]
    }
}
