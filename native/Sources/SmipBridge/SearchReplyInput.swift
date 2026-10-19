// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

struct SearchReplyInput {
    private struct SearchMatch {
        let filePath: String
        let lineNumber: Int
        let lineText: String
    }

    private let contentMatchesFull: [SearchMatch]
    private let pathMatchesFull: [String]
    private let maxResults: Int

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "matches", "paths", "maxResults"])
        guard let matches = try fields.value("matches") as? [Any],
              let paths = try fields.value("paths") as? [String]
        else { throw BridgeFailure("nativeProtocolError") }
        contentMatchesFull = try matches.map { value in
            let match = try WireObject(value, keys: ["filePath", "lineNumber", "lineText"])
            let line = try match.integer("lineNumber")
            guard line >= 0 else { throw BridgeFailure("nativeProtocolError") }
            return try SearchMatch(
                filePath: match.text("filePath"),
                lineNumber: line,
                lineText: match.text("lineText")
            )
        }
        pathMatchesFull = paths
        maxResults = try fields.integer("maxResults")
    }

    func render() throws -> [String: Any] {
        var dtoBuildLimitHit = false
        let budget = max(0, 50000 - 2000)
        var usedChars = 0
        var includedContentMatches: [SearchMatch] = []
        for match in contentMatchesFull {
            try Task.checkCancellation()
            let lineStr = "\(match.filePath):\(match.lineNumber + 1): \(match.lineText)"
            let cost = lineStr.count + 3
            if usedChars + cost > budget { break }
            includedContentMatches.append(match)
            usedChars += cost
        }
        var includedPathLines: [String] = []
        for path in pathMatchesFull {
            try Task.checkCancellation()
            let cost = path.count + 3
            if usedChars + cost > budget { break }
            includedPathLines.append(path)
            usedChars += cost
        }
        let omittedContent = contentMatchesFull.count - includedContentMatches.count
        let omittedPaths = pathMatchesFull.count - includedPathLines.count
        let sizeLimitHit = omittedContent + omittedPaths > 0
        let hitMaxCountLimit = contentMatchesFull.count >= maxResults || pathMatchesFull.count >= maxResults
        dtoBuildLimitHit = sizeLimitHit || hitMaxCountLimit
        let perFileTotals: [[String: Any]] = Dictionary(grouping: contentMatchesFull, by: \.filePath)
            .mapValues(\.count)
            .sorted { $0.key < $1.key }
            .map { ["path": $0.key, "count": $0.value] }
        return [
            "kind": "searchReply",
            "contentCount": includedContentMatches.count,
            "pathCount": includedPathLines.count,
            "totalFiles": Set(includedContentMatches.map(\.filePath)).count,
            "matchedFiles": Set(contentMatchesFull.map(\.filePath)).union(Set(pathMatchesFull)).count,
            "pathMatchLines": includedPathLines,
            "limitHit": dtoBuildLimitHit,
            "sizeLimitHit": sizeLimitHit,
            "omittedContentMatches": omittedContent,
            "omittedPathMatches": omittedPaths,
            "perFileTotals": perFileTotals
        ]
    }
}

struct SearchCountReplyInput {
    private let contentMatches: Int
    private let contentFileCount: Int
    private let displayedPathMatches: [String]

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "contentMatches", "contentFiles", "paths"])
        contentMatches = try fields.integer("contentMatches")
        contentFileCount = try fields.integer("contentFiles")
        guard contentMatches >= 0, contentFileCount >= 0,
              let paths = try fields.value("paths") as? [String]
        else { throw BridgeFailure("nativeProtocolError") }
        displayedPathMatches = paths
    }

    func render() -> [String: Any] {
        let normalizedPathMatches = Set(displayedPathMatches)
        // Count-only scans retain content counts but no content rows, so matchedFiles counts only path hits.
        return [
            "kind": "searchReply",
            "contentCount": contentMatches,
            "pathCount": normalizedPathMatches.count,
            "totalFiles": contentFileCount,
            "matchedFiles": normalizedPathMatches.count,
            "pathMatchLines": Array(normalizedPathMatches).sorted(),
            "limitHit": false,
            "sizeLimitHit": false,
            "omittedContentMatches": 0,
            "omittedPathMatches": 0,
            "perFileTotals": [] as [[String: Any]]
        ]
    }
}
