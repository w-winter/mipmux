import Foundation

struct SearchPatternInput {
    private let pattern: String
    private let isRegex: Bool
    private let wholeWord: Bool

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "text", "queryKind", "wholeWord"])
        pattern = try input.text("text").trimmingCharacters(in: .whitespacesAndNewlines)
        let queryKind = try input.string("queryKind")
        guard ["auto", "literal", "regex"].contains(queryKind) else { throw BridgeFailure("nativeProtocolError") }
        isRegex = queryKind == "auto" ? RPCESearchPattern.containsRegexSyntax(pattern) : queryKind == "regex"
        wholeWord = try input.boolean("wholeWord")
    }

    func render() -> [String: Any] {
        guard !pattern.isEmpty else {
            let message = "pattern cannot be empty; provide a non-empty search term. " +
                "If you intend to enumerate files, use get_file_tree or specify a path mode " +
                "with a wildcard like '*.swift'."
            return ["kind": "searchPatternError", "message": message]
        }
        let fuzzy = !isRegex && pattern.contains(" ")
        return ["kind": "searchPattern", "path": ["text": pattern, "isRegex": isRegex, "wholeWord": false],
                "content": ["text": fuzzy ? RPCESearchPattern.convertSpacesToFuzzyRegex(pattern) : pattern,
                            "isRegex": isRegex || fuzzy, "wholeWord": wholeWord && !fuzzy]]
    }
}
