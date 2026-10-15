// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
// Retained method bodies keep the original branch order and layout.
import Foundation
import RepoPromptRegexCore

enum RPCESearchPattern {
    // swiftlint:disable opening_brace for_where
    // swiftlint:disable:next cyclomatic_complexity function_body_length
    static func containsRegexSyntax(_ pattern: String) -> Bool {
        if RegexToolkit.usesPCREOnlyFeatures(pattern) {
            return true
        }

        // Check for clear regex patterns that are unlikely to be literal searches

        // Check for parentheses (capture groups) - but only if they look like regex
        // e.g., "(foo|bar)" or "func()" - we need to be smart about this
        if pattern.contains("(") && pattern.contains(")") {
            // Check if it's likely a regex group (has | inside or special chars)
            if let openParen = pattern.firstIndex(of: "("),
               let closeParen = pattern.firstIndex(of: ")"),
               openParen < closeParen
            {
                let insideParens = String(pattern[pattern.index(after: openParen) ..< closeParen])
                // If there's a pipe inside parens, it's likely regex
                if insideParens.contains("|") {
                    return true
                }
                // If the pattern starts with common regex anchors/modifiers before the paren
                let beforeParen = String(pattern[..<openParen])
                if beforeParen.hasSuffix("?:") || beforeParen.hasSuffix("?=") ||
                    beforeParen.hasSuffix("?!") || beforeParen.hasSuffix("?<=") ||
                    beforeParen.hasSuffix("?<!")
                {
                    return true
                }
            }
        }

        // Pipe operator with non-empty alternatives on both sides (e.g., "foo|bar")
        // This avoids false positives for lone pipes or pipes at edges
        if pattern.contains("|") {
            let components = pattern.split(separator: "|", omittingEmptySubsequences: false)
            // Only treat as regex if there are at least 2 non-empty components
            let nonEmptyCount = components.count(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })
            if nonEmptyCount >= 2 {
                return true
            }
        }

        // Common regex patterns that are very unlikely to be literal searches
        let strongRegexPatterns = [
            "\\b", // Word boundary
            "\\w", // Word character
            "\\d", // Digit
            "\\s", // Whitespace
            "\\n", // Newline
            "\\t", // Tab
            "^$", // Empty line
            ".*", // Any character sequence
            ".+" // At least one character
        ]

        for regexPattern in strongRegexPatterns {
            if pattern.contains(regexPattern) {
                return true
            }
        }

        // Check for character classes [...]
        if let openBracket = pattern.firstIndex(of: "["),
           let closeBracket = pattern.firstIndex(of: "]"),
           openBracket < closeBracket
        {
            return true
        }

        // Check for quantifiers {n,m}
        if let openBrace = pattern.firstIndex(of: "{"),
           let closeBrace = pattern.firstIndex(of: "}"),
           openBrace < closeBrace
        {
            let between = pattern[pattern.index(after: openBrace) ..< closeBrace]
            // Check if it looks like a quantifier (digits and comma)
            if between.allSatisfy({ $0.isNumber || $0 == "," }) {
                return true
            }
        }

        // Check for anchors at start/end
        if pattern.hasPrefix("^") || pattern.hasSuffix("$") {
            return true
        }

        return false
    }
    // swiftlint:enable opening_brace for_where

    static func convertSpacesToFuzzyRegex(_ pattern: String) -> String {
        pattern
            .split(separator: " ", omittingEmptySubsequences: false)
            .map { RepoPromptPCRE2Adapter.escapedLiteral(String($0)) }
            .joined(separator: "\\s+")
    }
}
