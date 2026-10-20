// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation
import RepoPromptRegexCore

// swiftlint:disable function_body_length cyclomatic_complexity opening_brace
extension RPCESearchRegex {
    static func scanLiteralCountOnlyFastPath(
        _ needle: String,
        in text: String,
        caseInsensitive: Bool,
        wholeWord: Bool,
        fuzzySpaceMatching: Bool
    ) throws -> SearchScanSummary? {
        if needle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return SearchScanSummary(hits: [], lineMatchCount: 0)
        }

        if fuzzySpaceMatching, needle.contains(" ") {
            let fuzzyPattern = RPCESearchPattern.convertSpacesToFuzzyRegex(needle)
            let regex = try RPCESearchRegexCache.pcre2Regex(for: RepoPromptPCRE2CompileRequest(
                pattern: fuzzyPattern,
                caseInsensitive: caseInsensitive,
                multilineAnchors: false
            ))
            let result = try regex.withMatchSession(matchLimits: RepoPromptPCRE2MatchPolicy.fileSearchLine) { session in
                try session.scanMatchingLines(
                    in: text,
                    options: PCRE2LineScanOptions(collectMatches: false),
                    shouldCancel: { Task.isCancelled }
                )
            }
            return SearchScanSummary(hits: [], lineMatchCount: result.lineMatchCount)
        }

        if let wholeWordLiteral = RepoPromptPCRE2Adapter.asciiWholeWordLiteralPlan(
            pattern: needle,
            isRegex: false,
            wholeWord: wholeWord,
            caseInsensitive: caseInsensitive
        ) {
            guard let lineCount = wholeWordLiteral.countMatchingLines(in: text) else { return nil }
            return SearchScanSummary(hits: [], lineMatchCount: lineCount)
        }

        if wholeWord {
            let escaped = RepoPromptPCRE2Adapter.escapedLiteral(needle)
            let regex = try RPCESearchRegexCache.pcre2Regex(for: RepoPromptPCRE2CompileRequest(
                pattern: "\\b\(escaped)\\b",
                caseInsensitive: caseInsensitive,
                multilineAnchors: false
            ))
            let result = try regex.withMatchSession(matchLimits: RepoPromptPCRE2MatchPolicy.fileSearchLine) { session in
                try session.scanMatchingLines(
                    in: text,
                    options: PCRE2LineScanOptions(collectMatches: false),
                    shouldCancel: { Task.isCancelled }
                )
            }
            return SearchScanSummary(hits: [], lineMatchCount: result.lineMatchCount)
        }

        return SearchScanSummary(
            hits: [],
            lineMatchCount: countLiteralMatchingLines(needle, in: text, caseInsensitive: caseInsensitive)
        )
    }

    private static func countLiteralMatchingLines(
        _ needle: String,
        in text: String,
        caseInsensitive: Bool
    ) -> Int {
        let nsText = text as NSString
        let length = nsText.length
        guard length > 0 else { return 0 }
        let compareOptions: NSString.CompareOptions = caseInsensitive ? [.caseInsensitive] : []
        var lineStartUTF16 = 0
        var offsetUTF16 = 0
        var lineNumber = 0
        var matchCount = 0
        let scalars = text.unicodeScalars
        var index = scalars.startIndex

        func scanLine(endingAtUTF16 endUTF16: Int) {
            if nsText.range(
                of: needle,
                options: compareOptions,
                range: NSRange(location: lineStartUTF16, length: max(0, endUTF16 - lineStartUTF16))
            ).location != NSNotFound {
                matchCount += 1
            }
            lineNumber += 1
        }

        func consume(_ scalar: UnicodeScalar) {
            offsetUTF16 += scalar.utf16.count
        }

        while index < scalars.endIndex {
            if (lineNumber & 0xFF) == 0, Task.isCancelled { break }
            let scalar = scalars[index]
            if scalar.value == 13 || scalar.value == 10 { // CR or LF; mirrors SearchLineIndex line boundaries.
                scanLine(endingAtUTF16: offsetUTF16)
                consume(scalar)
                index = scalars.index(after: index)

                if scalar.value == 13, index < scalars.endIndex, scalars[index].value == 10 {
                    consume(scalars[index])
                    index = scalars.index(after: index)
                }

                lineStartUTF16 = offsetUTF16
            } else {
                consume(scalar)
                index = scalars.index(after: index)
            }
        }

        if lineStartUTF16 < length, !Task.isCancelled {
            scanLine(endingAtUTF16: length)
        }

        return matchCount
    }

    static func scanLiteral(
        _ needle: String,
        in document: SearchDocument,
        caseInsensitive: Bool,
        wholeWord: Bool = false,
        fuzzySpaceMatching: Bool = true,
        countOnly: Bool = false,
        maxCollectedMatches: Int? = nil
    ) throws -> SearchScanSummary {
        func finish(_ summary: SearchScanSummary) -> SearchScanSummary {
            summary
        }
        func reachedCollectionLimit() -> Bool {
            !countOnly && (maxCollectedMatches.map { hits.count >= $0 } ?? false)
        }

        if needle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return finish(SearchScanSummary(hits: [], lineMatchCount: 0))
        }

        let nsText = document.nsText
        let compareOptions: NSString.CompareOptions = caseInsensitive ? [.caseInsensitive] : []
        var hitCount = 0
        var hits: [SearchHit] = []
        if !countOnly {
            hits.reserveCapacity(8)
        }

        let fuzzyRegex: PCRE2Regex? = try {
            guard fuzzySpaceMatching, needle.contains(" ") else { return nil }
            let fuzzyPattern = RPCESearchPattern.convertSpacesToFuzzyRegex(needle)
            return try RPCESearchRegexCache.pcre2Regex(for: RepoPromptPCRE2CompileRequest(
                pattern: fuzzyPattern,
                caseInsensitive: caseInsensitive,
                multilineAnchors: false
            ))
        }()

        let wholeWordLiteral = fuzzyRegex == nil
            ? RepoPromptPCRE2Adapter.asciiWholeWordLiteralPlan(
                pattern: needle,
                isRegex: false,
                wholeWord: wholeWord,
                caseInsensitive: caseInsensitive
            )
            : nil

        if let wholeWordLiteral,
           let result = wholeWordLiteral.scanMatchingLines(
               in: document.text,
               collectMatches: !countOnly,
               maxCollectedMatches: maxCollectedMatches,
               shouldCancel: { Task.isCancelled }
           )
        {
            return finish(SearchScanSummary(
                hits: result.matchingLineNumbers.map(SearchHit.init(lineNumber:)),
                lineMatchCount: result.lineMatchCount
            ))
        }

        let wholeWordRegex: PCRE2Regex? = try {
            guard fuzzyRegex == nil, wholeWord else { return nil }
            let escaped = RepoPromptPCRE2Adapter.escapedLiteral(needle)
            let pattern = "\\b\(escaped)\\b"
            return try RPCESearchRegexCache.pcre2Regex(for: RepoPromptPCRE2CompileRequest(
                pattern: pattern,
                caseInsensitive: caseInsensitive,
                multilineAnchors: false
            ))
        }()

        if let regex = fuzzyRegex ?? wholeWordRegex {
            return try regex.withMatchSession(matchLimits: RepoPromptPCRE2MatchPolicy.fileSearchLine) { session in
                for lineNumber in document.lineRanges.indices {
                    if (lineNumber & 0xFF) == 0, Task.isCancelled {
                        return finish(SearchScanSummary(hits: hits, lineMatchCount: hitCount))
                    }

                    if try session.containsMatch(in: document.lineSlice(at: lineNumber)) {
                        hitCount += 1
                        if !countOnly, maxCollectedMatches.map({ hits.count < $0 }) ?? true {
                            hits.append(SearchHit(lineNumber: lineNumber))
                            if reachedCollectionLimit() {
                                return finish(SearchScanSummary(hits: hits, lineMatchCount: hitCount))
                            }
                        }
                    }
                }

                return finish(SearchScanSummary(hits: hits, lineMatchCount: hitCount))
            }
        }

        for (lineNumber, lineRange) in document.lineRanges.enumerated() {
            if (lineNumber & 0xFF) == 0, Task.isCancelled {
                return finish(SearchScanSummary(hits: hits, lineMatchCount: hitCount))
            }

            if nsText.range(of: needle, options: compareOptions, range: lineRange).location != NSNotFound {
                hitCount += 1
                if !countOnly, maxCollectedMatches.map({ hits.count < $0 }) ?? true {
                    hits.append(SearchHit(lineNumber: lineNumber))
                    if reachedCollectionLimit() { break }
                }
            }
        }

        return finish(SearchScanSummary(hits: hits, lineMatchCount: hitCount))
    }
}

// swiftlint:enable function_body_length cyclomatic_complexity opening_brace
