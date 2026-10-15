import Foundation

struct LiteralSearchInput {
    private let lines: [String]
    private let pattern: String
    private let caseSensitive: Bool
    private let countOnly: Bool
    private let limit: Int

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "lines", "pattern", "caseSensitive", "countOnly", "limit"])
        guard let lines = try input.value("lines") as? [String] else { throw BridgeFailure("nativeProtocolError") }
        self.lines = lines
        pattern = try input.text("pattern")
        guard !pattern.isEmpty else { throw BridgeFailure("nativeProtocolError") }
        caseSensitive = try input.boolean("caseSensitive")
        countOnly = try input.boolean("countOnly")
        limit = try input.integer("limit")
    }

    func render() throws -> [String: Any] {
        let options: NSString.CompareOptions = caseSensitive ? [] : [.caseInsensitive]
        var matches: [[String: Int]] = []
        var matchingLines = 0
        var occurrences = 0
        for (index, line) in lines.enumerated() {
            try Task.checkCancellation()
            if !countOnly, matchingLines >= limit { break }
            let text = line as NSString
            var cursor = 0
            var count = 0
            while cursor < text.length {
                let found = text.range(of: pattern, options: options,
                                       range: NSRange(location: cursor, length: text.length - cursor))
                if found.location == NSNotFound { break }
                count += 1
                cursor = NSMaxRange(found)
            }
            if count > 0 {
                matchingLines += 1
                occurrences += count
                if !countOnly { matches.append(["number": index + 1, "occurrences": count]) }
            }
        }
        return ["kind": "literalSearch", "matches": matches, "matchingLines": matchingLines, "occurrences": occurrences]
    }
}
