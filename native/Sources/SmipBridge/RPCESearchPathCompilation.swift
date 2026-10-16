// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation
import RepoPromptRegexCore

extension RPCESearchPaths {
    static func compilePathRegex(
        pattern: String,
        caseInsensitive: Bool
    ) throws -> PCRE2Regex {
        func compileCandidate(_ candidate: String) throws -> PCRE2Regex {
            try RPCESearchRegexCache.pcre2Regex(for: RepoPromptPCRE2CompileRequest(
                pattern: candidate,
                caseInsensitive: caseInsensitive,
                multilineAnchors: false
            ))
        }

        var lastError: Error?
        do {
            return try compileCandidate(pattern)
        } catch {
            lastError = error
        }

        let compressed = RepoPromptPCRE2Adapter.compressDoubleEscapesBeforeMeta(pattern)
        if compressed != pattern {
            do {
                return try compileCandidate(compressed)
            } catch {
                lastError = error
            }
        }

        do {
            let normalised = try RegexToolkit.normalise(pattern)
            var repairedPattern = normalised.text
            let compressedAfterNormalize = RepoPromptPCRE2Adapter.compressDoubleEscapesBeforeMeta(repairedPattern)
            if compressedAfterNormalize != repairedPattern {
                repairedPattern = compressedAfterNormalize
            }
            return try compileCandidate(repairedPattern)
        } catch {
            lastError = error
        }

        throw RepoPromptPCRE2Adapter.searchPatternError(
            from: lastError ?? SearchPatternError.invalidRegex(pattern, "Failed to compile regular expression"),
            pattern: pattern
        )
    }
}
