// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation
import RepoPromptRegexCore

struct SearchRecoveryInput {
    private let pattern: String
    private let isRegex: Bool

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "pattern", "isRegex"])
        pattern = try input.text("pattern")
        isRegex = try input.boolean("isRegex")
    }

    func render() -> [String: Any] {
        var attempts: [[String: String]] = []
        if !isRegex {
            if let repaired = Self.repairedLiteralPattern(pattern), repaired != pattern {
                attempts.append(["kind": "literal", "pattern": repaired])
            }
        } else {
            if Self.looksOverEscapedRegex(pattern) {
                let compressed = RepoPromptPCRE2Adapter.compressDoubleEscapesBeforeMeta(pattern)
                if compressed != pattern {
                    attempts.append(["kind": "compressedRegex", "pattern": compressed])
                }
            }
            if let normalized = try? RegexToolkit.normalise(pattern), normalized.text != pattern {
                attempts.append(["kind": "normalizedRegex", "pattern": normalized.text])
            }
            let literalCandidate = Self.unescapeLiteralRegexEscapes(pattern)
            if literalCandidate != pattern {
                attempts.append(["kind": "quotedRegex",
                                 "pattern": RepoPromptPCRE2Adapter.escapedLiteral(literalCandidate)])
            }
        }
        return ["kind": "searchRecovery", "attempts": attempts,
                "warning": RPCESearchWarning.searchAutoCorrectionWarning(isRegex: isRegex)]
    }

    // swiftlint:disable identifier_name
    private static let regexMeta: Set<Character> = ["(", ")", "[", "]", "{", "}", ".", "*", "+", "?", "|", "^", "$"]

    /// Looks like a literal with unnecessary escapes (e.g., "\\(") and no "\\\\"
    private static func looksOverEscapedLiteral(_ s: String) -> Bool {
        if s.contains("\\\\") { return false } // double-backslash present → likely intended literal backslash
        let chars = Array(s)
        var i = 0
        var saw = false
        while i < chars.count - 1 {
            if chars[i] == "\\", regexMeta.contains(chars[i + 1]) {
                saw = true
                i += 2
            } else {
                i += 1
            }
        }
        return saw
    }

    /// Remove a single leading "\\" before regex meta characters only (for literal fallback)
    private static func unescapeLiteralRegexEscapes(_ s: String) -> String {
        let chars = Array(s)
        var out: [Character] = []
        out.reserveCapacity(chars.count)
        var i = 0
        while i < chars.count {
            if i < chars.count - 1, chars[i] == "\\", regexMeta.contains(chars[i + 1]) {
                out.append(chars[i + 1])
                i += 2
            } else {
                out.append(chars[i])
                i += 1
            }
        }
        return String(out)
    }

    /// Repairs literal patterns that were double-escaped through JSON or tool layers.
    /// Example: `"frame\\\\("` → `"frame("`
    private static func repairedLiteralPattern(_ pattern: String) -> String? {
        var candidate = pattern
        if Self.looksOverEscapedRegex(candidate) {
            let compressed = RepoPromptPCRE2Adapter.compressDoubleEscapesBeforeMeta(candidate)
            if compressed != candidate {
                candidate = compressed
                let chars = Array(candidate)
                if chars.count == 2, chars[0] == "\\", regexMeta.contains(chars[1]) {
                    return nil
                }
            }
        }
        guard Self.looksOverEscapedLiteral(candidate) else { return nil }
        let repaired = Self.unescapeLiteralRegexEscapes(candidate)
        return repaired != pattern ? repaired : nil
    }

    /// Detects patterns that likely have double-escapes before regex meta (e.g., "\\\\(")
    private static func looksOverEscapedRegex(_ s: String) -> Bool {
        let chars = Array(s)
        guard chars.count >= 3 else { return false }
        var i = 0
        while i < chars.count - 2 {
            if chars[i] == "\\", chars[i + 1] == "\\", regexMeta.contains(chars[i + 2]) {
                return true
            }
            i += 1
        }
        return false
    }

    // swiftlint:enable identifier_name
}
