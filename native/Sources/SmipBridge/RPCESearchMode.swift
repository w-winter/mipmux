// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

enum SearchMode: String, Codable {
    case auto, path, content, both
}

extension RPCESearchPattern {
    // swiftlint:disable opening_brace identifier_name
    private static let regexMeta: Set<Character> = ["(", ")", "[", "]", "{", "}", ".", "*", "+", "?", "|", "^", "$"]

    // swiftlint:disable:next cyclomatic_complexity
    static func inferredAutoMode(_ raw: String) -> SearchMode {
        // Quick heuristics (order matters) - designed for intuitive user experience

        // REGEX PATTERNS should search content, not paths
        if containsRegexSyntax(raw) {
            return .content
        }

        // Strong path indicators should override other signals
        if raw.hasPrefix("*") || raw.hasPrefix(".") {
            return .path
        }

        // Check for wildcards anywhere in the pattern
        if raw.contains("*") || raw.contains("?") {
            return .path
        }

        // Forward slashes are strong path indicators unless it's clearly content (like a sentence)
        if raw.contains("/") {
            // If it has spaces but is short and path-like, still treat as path
            if raw.contains(" "), raw.count > 20 {
                return .content // Long patterns with spaces are likely content
            }
            return .path
        }

        // Backslashes are ambiguous: they may indicate Windows paths, or escaped literal metacharacters.
        if raw.contains("\\") {
            if backslashesOnlyEscapeRegexMeta(raw) {
                return .content
            }
            if raw.contains(" "), raw.count > 20 {
                return .content
            }
            return .path
        }

        // Content indicators
        if raw.contains("\n") { return .content }
        if raw.contains(" "), raw.count > 10 { return .content }

        // Short patterns should search both to be thorough
        if raw.count <= 3 { return .both }

        // Identifier-like tokens (e.g., "Player", "Bomb", "MyClass.swift") should search both
        // paths and content - this is the most intuitive UX for code search
        if isIdentifierLike(raw) { return .both }

        // Medium patterns with spaces are likely content searches
        if raw.contains(" ") { return .content }

        // Everything else defaults to content (most common use case)
        return .content
    }

    private static func backslashesOnlyEscapeRegexMeta(_ raw: String) -> Bool {
        let chars = Array(raw)
        var index = 0
        var sawEscapedMeta = false
        while index < chars.count {
            guard chars[index] == "\\" else {
                index += 1
                continue
            }
            if index + 2 < chars.count,
               chars[index + 1] == "\\",
               regexMeta.contains(chars[index + 2])
            {
                sawEscapedMeta = true
                index += 3
                continue
            }
            if index + 1 < chars.count,
               regexMeta.contains(chars[index + 1])
            {
                sawEscapedMeta = true
                index += 2
                continue
            }
            return false
        }
        return sawEscapedMeta
    }

    private static func isIdentifierLike(_ s: String) -> Bool {
        guard !s.isEmpty else { return false }

        // Must be a single token (no spaces or path separators)
        if s.contains(" ") || s.contains("/") || s.contains("\\") { return false }

        // No obvious regex metacharacters
        let forbidden: Set<Character> = ["*", "+", "?", "[", "]", "{", "}", "(", ")", "|", "^", "$"]
        if s.contains(where: forbidden.contains) { return false }

        // Restrict to common identifier/filename characters: letters, digits, dot, underscore, hyphen
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
        if s.unicodeScalars.contains(where: { !allowed.contains($0) }) { return false }

        return true
    }
    // swiftlint:enable opening_brace identifier_name
}
