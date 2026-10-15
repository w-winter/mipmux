// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation
import RepoPromptC
import RepoPromptRegexCore

// swiftlint:disable identifier_name line_length
private let WM_CASEFOLD: UInt32 = 0x10 // must match wildmatch.h
private let WM_WILDSTAR: UInt32 = 0x40 // must match wildmatch.h
private let WM_MATCH: Int32 = 0

struct SearchPathScanPlan {
    let trimmedPattern: String
    let regex: PCRE2Regex?
    let pathSuffixPattern: PCRE2PathSuffixPattern?
    let caseInsensitive: Bool
    let isRegex: Bool
    let aliasByRootPath: [String: String]?
}

enum RPCESearchPaths {
    private static func endsWithWildcard(_ s: String) -> Bool {
        guard let last = s.last else { return false }
        return last == "*" || last == "?"
    }

    /// Helper: generate friendly fallback candidates for path globs
    private static func pathGlobCandidates(for pattern: String) -> [String] {
        var cands: [String] = [pattern]
        let hasSlash = pattern.contains("/")
        let needsSuffixStar = !endsWithWildcard(pattern)

        // Try matching at any depth if user didn't scope with '/'
        if !hasSlash, !pattern.hasPrefix("**/") {
            cands.append("**/" + pattern)
        }
        // If user forgot a trailing wildcard, try broadening
        if needsSuffixStar {
            cands.append(pattern + "*")
            if !hasSlash, !pattern.hasPrefix("**/") {
                cands.append("**/" + pattern + "*")
            }
        }
        // Deduplicate while preserving order
        var seen = Set<String>()
        var out: [String] = []
        for c in cands where seen.insert(c).inserted {
            out.append(c)
        }
        return out
    }

    static func scanPath(_ file: SearchPathFile, plan: SearchPathScanPlan) throws -> Bool {
        let candidatePaths = Self.candidatePaths(for: file, aliasByRootPath: plan.aliasByRootPath)

        do {
            if plan.isRegex, let pathSuffixPattern = plan.pathSuffixPattern {
                return candidatePaths.contains { pathSuffixPattern.matches($0, caseInsensitive: plan.caseInsensitive) }
            }

            // If it's a regex pattern, use the path-specific compiled regex.
            if plan.isRegex, let regex = plan.regex {
                return try regex.withMatchSession(matchLimits: RepoPromptPCRE2MatchPolicy.pathSearchShortSubject) { session in
                    try candidatePaths.contains { hay in
                        try session.containsMatch(in: hay)
                    }
                }
            }

            // For non-regex patterns, check if it has wildcards
            let hasWildcards = plan.trimmedPattern.contains("*") || plan.trimmedPattern.contains("?")

            if hasWildcards {
                // Try the user's pattern first, then friendly fallbacks
                for cand in Self.pathGlobCandidates(for: plan.trimmedPattern) {
                    // Enable WILDSTAR only if candidate contains "**" (needs globstar)
                    let useWildstar = cand.contains("**")
                    let flags: UInt32 = (useWildstar ? WM_WILDSTAR : 0)
                        | (plan.caseInsensitive ? WM_CASEFOLD : 0)
                    let matched = cand.withCString { patternC in
                        candidatePaths.contains { path in
                            path.withCString { pathC in
                                repo_wildmatch(patternC, pathC, flags) == WM_MATCH
                            }
                        }
                    }
                    if matched { return true }
                }
                return false
            } else {
                // Literal string matching
                return candidatePaths.contains { path in
                    Self.containsSubstring(path, needle: plan.trimmedPattern, caseInsensitive: plan.caseInsensitive)
                }
            }
        } catch let error as PCRE2Error {
            throw RepoPromptPCRE2Adapter.searchPatternError(from: error, pattern: plan.trimmedPattern)
        } catch let error as RegexPatternFailure {
            throw error
        }
    }

    private static func candidatePaths(for file: SearchPathFile, aliasByRootPath: [String: String]?) -> [String] {
        var seen = Set<String>()
        var candidates: [String] = []

        func appendCandidate(_ path: String) {
            guard !path.isEmpty else { return }
            if seen.insert(path).inserted {
                candidates.append(path)
            }
        }

        // 1) Standardized repo-relative path (what path search exposes)
        let relativePath = StandardizedPath.relative(file.standardizedRelativePath)
        appendCandidate(relativePath)

        // 2) Optional alias-prefixed path for multi-root workspaces
        if let aliasByRootPath {
            let rootKey = file.standardizedRootFolderPath
            if let alias = aliasByRootPath[rootKey] {
                let aliasPrefixed = relativePath.isEmpty ? alias : "\(alias)/\(relativePath)"
                appendCandidate(aliasPrefixed)
            }
        }

        // NOTE: We deliberately DO NOT include file.standardizedFullPath here.
        // Including the full absolute path caused queries like "Bomb" to match
        // every file when the workspace root was named "BombSquad", because the
        // absolute path "/Users/.../BombSquad/..." matched even though users
        // only see repo-relative paths in results. Any tooling that needs
        // absolute-path matching should use WorkspaceFilesViewModel + PathMatchWorker.

        return candidates
    }

    private static func containsSubstring(_ haystack: String, needle: String, caseInsensitive: Bool) -> Bool {
        let options: String.CompareOptions = caseInsensitive ? [.caseInsensitive] : []
        return haystack.range(of: needle, options: options) != nil
    }
}

// swiftlint:enable identifier_name line_length
