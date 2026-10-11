// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: scope the original static helpers to the native patch owner.
// Preserve source identifiers and ordering; CCCC remains enabled.
// swiftlint:disable identifier_name
import Foundation

enum RPCEGitPatchSplitter {
    /// Split a unified diff output into per-file diff strings.
    static func splitUnifiedDiffByFile(_ diff: String) -> [String: String] {
        guard !diff.isEmpty else { return [:] }
        let endsWithNewline = diff.hasSuffix("\n")
        let lines = diff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var result: [String: String] = [:]
        var currentBlock: [String] = []

        for line in lines {
            if line.hasPrefix("diff --git ") {
                finalizeUnifiedDiffBlock(currentBlock, endsWithNewline: endsWithNewline, into: &result)
                currentBlock = [line]
                continue
            }
            guard !currentBlock.isEmpty else { continue }
            currentBlock.append(line)
        }

        finalizeUnifiedDiffBlock(currentBlock, endsWithNewline: endsWithNewline, into: &result)
        return result
    }

    private static func finalizeUnifiedDiffBlock(
        _ block: [String],
        endsWithNewline: Bool,
        into result: inout [String: String]
    ) {
        guard !block.isEmpty, let path = canonicalPath(forUnifiedDiffBlock: block) else { return }
        var text = block.joined(separator: "\n")
        if endsWithNewline, !text.hasSuffix("\n") {
            text += "\n"
        }
        result[path] = text
    }

    private struct PatchHeaderPaths {
        let oldPath: String
        let newPath: String
        let prefixes: Set<String>
    }

    private static func canonicalPath(forUnifiedDiffBlock block: [String]) -> String? {
        var headerPaths: PatchHeaderPaths?
        var renameToPath: String?
        var copyToPath: String?
        var plusPath: String?
        var minusPath: String?

        for line in block {
            if line.hasPrefix("diff --git ") {
                headerPaths = parseDiffGitHeaderPaths(line)
                continue
            }
            if line.hasPrefix("rename to ") {
                renameToPath = parseGitPathRemainder(String(line.dropFirst("rename to ".count)))
                continue
            }
            if line.hasPrefix("copy to ") {
                copyToPath = parseGitPathRemainder(String(line.dropFirst("copy to ".count)))
                continue
            }
            if line.hasPrefix("+++ ") {
                plusPath = parseGitPathRemainder(String(line.dropFirst("+++ ".count))).flatMap {
                    normalizePatchHeaderPath($0, stripping: headerPaths?.prefixes)
                }
                continue
            }
            if line.hasPrefix("--- ") {
                minusPath = parseGitPathRemainder(String(line.dropFirst("--- ".count))).flatMap {
                    normalizePatchHeaderPath($0, stripping: headerPaths?.prefixes)
                }
                continue
            }
            if line.hasPrefix("@@") {
                break
            }
        }

        return renameToPath ?? copyToPath ?? plusPath ?? minusPath ?? headerPaths?.newPath ?? headerPaths?.oldPath
    }

    private static func parseDiffGitHeaderPaths(_ line: String) -> PatchHeaderPaths? {
        let prefix = "diff --git "
        guard line.hasPrefix(prefix) else { return nil }
        let remainder = String(line.dropFirst(prefix.count))
        let tokens = parseDiffGitTokens(remainder)
        let prefixes = patchHeaderPrefixes(oldRawPath: tokens.first, newRawPath: tokens.dropFirst().first)
        guard tokens.count >= 2,
              let oldPath = normalizePatchHeaderPath(tokens[0], stripping: prefixes),
              let newPath = normalizePatchHeaderPath(tokens[1], stripping: prefixes)
        else {
            return nil
        }
        return PatchHeaderPaths(oldPath: oldPath, newPath: newPath, prefixes: prefixes)
    }

    private static func parseGitPathRemainder(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.first == "\"" {
            return parseDiffGitTokens(trimmed).first
        }
        return trimmed
    }

    private static func normalizePatchHeaderPath(_ rawPath: String, stripping prefixes: Set<String>? = nil) -> String? {
        var normalized = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized != "/dev/null" else { return nil }
        let prefixes = prefixes ?? defaultPatchHeaderPrefixes
        if prefixes.contains(String(normalized.prefix(2))) {
            normalized = String(normalized.dropFirst(2))
        }
        if normalized.hasPrefix("./") {
            normalized = String(normalized.dropFirst(2))
        }
        return normalized.isEmpty ? nil : normalized
    }

    private static let defaultPatchHeaderPrefixes: Set<String> = ["a/", "b/"]

    private static let knownPatchHeaderPrefixPairs: [(old: String, new: String)] = [
        ("a/", "b/"),
        ("c/", "w/"),
        ("i/", "w/"),
        ("o/", "w/"),
        ("1/", "2/")
    ]

    private static func patchHeaderPrefixes(oldRawPath: String?, newRawPath: String?) -> Set<String> {
        guard let oldRawPath,
              let newRawPath,
              let oldPrefix = patchHeaderPrefix(in: oldRawPath),
              let newPrefix = patchHeaderPrefix(in: newRawPath),
              knownPatchHeaderPrefixPairs.contains(where: { $0.old == oldPrefix && $0.new == newPrefix })
        else {
            return defaultPatchHeaderPrefixes
        }
        return [oldPrefix, newPrefix]
    }

    private static func patchHeaderPrefix(in rawPath: String) -> String? {
        let trimmed = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { return nil }
        let prefix = String(trimmed.prefix(2))
        guard knownPatchHeaderPrefixPairs.contains(where: { $0.old == prefix || $0.new == prefix }) else {
            return nil
        }
        return prefix
    }

    private static func parseDiffGitTokens(_ input: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        var isQuoted = false
        var idx = input.startIndex

        while idx < input.endIndex {
            let ch = input[idx]
            if isQuoted {
                if ch == "\\" {
                    let next = input.index(after: idx)
                    if next >= input.endIndex { break }
                    let escaped = input[next]
                    if let octal = parseOctalEscape(escaped, input: input, start: next) {
                        current.append(octal.character)
                        idx = octal.nextIndex
                        continue
                    }
                    current.append(unescapeGitDiffCharacter(escaped))
                    idx = input.index(after: next)
                    continue
                }
                if ch == "\"" {
                    isQuoted = false
                    idx = input.index(after: idx)
                    continue
                }
                current.append(ch)
                idx = input.index(after: idx)
                continue
            }

            if ch == "\"" {
                isQuoted = true
                idx = input.index(after: idx)
                continue
            }
            if ch == " " {
                if !current.isEmpty {
                    tokens.append(current)
                    current = ""
                }
                idx = input.index(after: idx)
                continue
            }
            current.append(ch)
            idx = input.index(after: idx)
        }

        if !current.isEmpty {
            tokens.append(current)
        }
        return tokens
    }

    private static func unescapeGitDiffCharacter(_ ch: Character) -> Character {
        switch ch {
        case "n": "\n"
        case "t": "\t"
        case "r": "\r"
        case "\"": "\""
        case "\\": "\\"
        default: ch
        }
    }

    private static func parseOctalEscape(
        _ first: Character,
        input: String,
        start: String.Index
    ) -> (character: Character, nextIndex: String.Index)? {
        guard ("0" ... "7").contains(first) else { return nil }
        var digits = String(first)
        var nextIndex = input.index(after: start)
        while digits.count < 3, nextIndex < input.endIndex {
            let ch = input[nextIndex]
            guard ("0" ... "7").contains(ch) else { break }
            digits.append(ch)
            nextIndex = input.index(after: nextIndex)
        }
        guard let scalar = UInt8(digits, radix: 8) else { return nil }
        let scalarValue = UnicodeScalar(scalar)
        return (Character(scalarValue), nextIndex)
    }
}

// swiftlint:enable identifier_name
