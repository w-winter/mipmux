// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation
import RepoPromptRegexCore

extension RPCESearchRegex {
    // Retained source layout and signatures are checked against the pinned ranges.
    // swiftlint:disable function_body_length line_length opening_brace
    private static let highRiskMaxLineLength = 512 // bytes

    /// PCRE2 calls are synchronous, so line-by-line fallback still caps risky line length.
    private static let pcre2RegexMaxLineLength = 64 * 1024 // 64 KB

    /// For very large files we avoid full-buffer PCRE2 scanning.
    /// Patterns like `xml.*trim` with unanchored greedy quantifiers can be extremely
    /// slow on large buffers because each C match call is synchronous and cannot be
    /// interrupted by cooperative cancellation.
    private static let maxPCRE2FullScanBytes = 1_000_000 // 1 MB
    private static func compilePrimaryEngine(
        pattern: String,
        caseInsensitive: Bool,
        wholeWord: Bool
    ) throws -> RegexEngine {
        let multilineAnchors = pattern.contains("^") || pattern.contains("$")

        if let asciiWholeWord = RepoPromptPCRE2Adapter.asciiWholeWordLiteralPlan(
            pattern: pattern,
            isRegex: true,
            wholeWord: wholeWord,
            caseInsensitive: caseInsensitive
        ) {
            return .asciiWholeWord(asciiWholeWord)
        }

        func pcre2CompileRequest(_ candidate: String) -> RepoPromptPCRE2CompileRequest {
            let effective = wholeWord ? "\\b\(candidate)\\b" : candidate
            return RepoPromptPCRE2CompileRequest(
                pattern: effective,
                caseInsensitive: caseInsensitive,
                multilineAnchors: multilineAnchors || effective.contains("^") || effective.contains("$")
            )
        }

        func compilePCRE2(_ candidate: String) throws -> PCRE2Regex {
            try RepoPromptPCRE2Adapter.compile(pcre2CompileRequest(candidate))
        }

        if !wholeWord,
           let anchoredDeclaration = RepoPromptPCRE2Adapter.anchoredDeclarationLinePlan(for: pattern, caseInsensitive: caseInsensitive)
        {
            return try .anchoredDeclaration(anchoredDeclaration, compilePCRE2(pattern))
        }

        if !wholeWord,
           let asciiMarker = RepoPromptPCRE2Adapter.asciiMarkerLinePatternPlan(forRegex: pattern, caseInsensitive: caseInsensitive)
        {
            return .asciiMarker(asciiMarker, pcre2CompileRequest(pattern))
        }

        return try .pcre2(compilePCRE2(pattern))
    }

    private static func scan(engine: RegexEngine, in document: SearchDocument, countOnly: Bool,
                             maxCollectedMatches: Int?, regexTraits: RegexScanTraits) throws -> SearchScanSummary
    {
        let traits = regexTraits
        switch engine {
        case let .pcre2(regex):
            if traits.anchored || traits.expensiveUnanchored || document.text.utf8.count > Self.maxPCRE2FullScanBytes {
                return try scanPCRE2RegexLineByLine(
                    regex,
                    in: document,
                    countOnly: countOnly,
                    maxCollectedMatches: maxCollectedMatches,
                    highRisk: traits.highRisk,
                    linePrefilter: traits.linePrefilter
                )
            }
            return try scanPCRE2Regex(regex, in: document, countOnly: countOnly, maxCollectedMatches: maxCollectedMatches)
        case let .asciiMarker(plan, fallbackRequest):
            if let result = plan.scanMatchingLines(
                in: document.text,
                collectMatches: !countOnly,
                maxCollectedMatches: maxCollectedMatches,
                shouldCancel: { Task.isCancelled }
            ) {
                return SearchScanSummary(
                    hits: result.matchingLineNumbers.map(SearchHit.init(lineNumber:)),
                    lineMatchCount: result.lineMatchCount
                )
            }
            let fallbackRegex = try RepoPromptPCRE2Adapter.compile(fallbackRequest)
            return try scanPCRE2Regex(fallbackRegex, in: document, countOnly: countOnly, maxCollectedMatches: maxCollectedMatches)
        case let .anchoredDeclaration(plan, fallbackRegex):
            if let result = plan.scanMatchingLines(
                in: document.text,
                collectMatches: !countOnly,
                maxCollectedMatches: maxCollectedMatches,
                cancellationCheckStride: 16,
                shouldCancel: { Task.isCancelled }
            ) {
                return SearchScanSummary(
                    hits: result.matchingLineNumbers.map(SearchHit.init(lineNumber:)),
                    lineMatchCount: result.lineMatchCount
                )
            }
            return try scanPCRE2RegexLineByLine(
                fallbackRegex,
                in: document,
                countOnly: countOnly,
                maxCollectedMatches: maxCollectedMatches,
                highRisk: traits.highRisk,
                linePrefilter: traits.linePrefilter
            )
        case let .asciiWholeWord(literal):
            if let result = literal.scanMatchingLines(
                in: document.text,
                collectMatches: !countOnly,
                maxCollectedMatches: maxCollectedMatches,
                shouldCancel: { Task.isCancelled }
            ) {
                return SearchScanSummary(
                    hits: result.matchingLineNumbers.map(SearchHit.init(lineNumber:)),
                    lineMatchCount: result.lineMatchCount
                )
            }
            let escaped = RepoPromptPCRE2Adapter.escapedLiteral(literal.needle)
            let fallback = try RepoPromptPCRE2Adapter.compile(RepoPromptPCRE2CompileRequest(
                pattern: "\\b\(escaped)\\b",
                caseInsensitive: literal.caseInsensitive,
                multilineAnchors: false
            ))
            return try scanPCRE2RegexLineByLine(fallback, in: document, countOnly: countOnly, maxCollectedMatches: maxCollectedMatches, highRisk: false, linePrefilter: nil)
        }
    }

    private static func scanPCRE2Regex(
        _ regex: PCRE2Regex,
        in document: SearchDocument,
        countOnly: Bool,
        maxCollectedMatches: Int? = nil
    ) throws -> SearchScanSummary {
        func finish(_ summary: SearchScanSummary) -> SearchScanSummary {
            summary
        }
        func reachedCollectionLimit() -> Bool {
            !countOnly && (maxCollectedMatches.map { hits.count >= $0 } ?? false)
        }

        if Task.isCancelled {
            return finish(SearchScanSummary(hits: [], lineMatchCount: 0))
        }

        var hitCount = 0
        var hits: [SearchHit] = []
        if !countOnly {
            hits.reserveCapacity(8)
        }
        var lastLineNumber: Int?
        var matchIndex = 0

        try regex.enumerateMatches(in: document.text, matchLimits: RepoPromptPCRE2MatchPolicy.fileSearchFullBuffer) { match in
            defer { matchIndex += 1 }
            if match.byteRange.isEmpty { return true }
            if (matchIndex & 0x0F) == 0, Task.isCancelled { return false }

            let lineNumber = document.lineNumber(forUTF8Offset: match.byteRange.lowerBound)
            guard lineNumber >= 0 else { return true }
            if lastLineNumber == lineNumber { return true }

            lastLineNumber = lineNumber
            hitCount += 1
            if !countOnly, maxCollectedMatches.map({ hits.count < $0 }) ?? true {
                hits.append(SearchHit(lineNumber: lineNumber))
                if reachedCollectionLimit() { return false }
            }
            return true
        }

        return finish(SearchScanSummary(hits: hits, lineMatchCount: hitCount))
    }

    private static func scanPCRE2RegexLineByLine(
        _ regex: PCRE2Regex,
        in document: SearchDocument,
        countOnly: Bool,
        maxCollectedMatches: Int? = nil,
        highRisk: Bool = false,
        linePrefilter: PCRE2LinePrefilter? = nil
    ) throws -> SearchScanSummary {
        try regex.withMatchSession(matchLimits: RepoPromptPCRE2MatchPolicy.fileSearchLine) { session in
            let result = try session.scanMatchingLines(
                in: document.text,
                options: PCRE2LineScanOptions(
                    maxLineUTF8Length: highRisk ? highRiskMaxLineLength : pcre2RegexMaxLineLength,
                    collectMatches: !countOnly,
                    maxCollectedMatches: maxCollectedMatches,
                    cancellationCheckStride: 16,
                    prefilter: linePrefilter
                ),
                shouldCancel: { Task.isCancelled }
            )
            return SearchScanSummary(
                hits: result.matchingLineNumbers.map(SearchHit.init(lineNumber:)),
                lineMatchCount: result.lineMatchCount
            )
        }
    }

    // swiftlint:enable function_body_length line_length opening_brace
    // ponytail: Patterns compile per file; reuse the source cache if workload measurements show material compile cost.
    // swiftlint:disable:next function_parameter_count
    static func run(
        text: String, pattern: String, caseInsensitive: Bool, wholeWord: Bool, countOnly: Bool, limit: Int
    ) throws -> SearchScanSummary {
        try RegexToolkit.validateComplexity(pattern, isRegex: true)
        let document = SearchDocument(text: text, lineIndex: SearchLineIndex(content: text))
        let traits = RegexScanTraits(
            anchored: RegexToolkit.isLineAnchored(pattern) || pattern.first == "^" || pattern.last == "$",
            expensiveUnanchored: RegexToolkit.isExpensiveUnanchored(pattern),
            highRisk: RegexToolkit.isHighRisk(pattern),
            linePrefilter: RepoPromptPCRE2Adapter.linePrefilterForAnchoredPattern(
                pattern, caseInsensitive: caseInsensitive
            )
        )
        let engine = try compilePrimaryEngine(pattern: pattern, caseInsensitive: caseInsensitive, wholeWord: wholeWord)
        return try scan(engine: engine, in: document, countOnly: countOnly,
                        maxCollectedMatches: countOnly ? nil : max(0, limit), regexTraits: traits)
    }
}
