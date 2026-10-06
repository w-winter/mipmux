// Modified for smip: declarations relocated and cross-file access adjusted.
import Foundation
import CoreFoundation

extension TypeCleaner {
    private enum TypeCleanerSets {
        static let swiftPrims: Set<String> = [
            "int", "int8", "int16", "int32", "int64",
            "uint", "uint8", "uint16", "uint32", "uint64",
            "float", "float32", "float64", "double",
            "bool", "boolean", "character", "string", "view", "void"
        ]
        static let csharpPrims: Set<String> = [
            "int", "float", "double", "bool", "boolean",
            "string", "char", "decimal", "long", "short", "byte", "object", "dynamic", "void"
        ]
        static let javaPrims: Set<String> = [
            "int", "float", "double", "boolean", "char", "short", "long", "byte", "string", "void"
        ]
        static let cPrims: Set<String> = [
            "int", "char", "short", "long", "bool", "float", "double", "void", "size_t", "wchar_t"
        ]
        static let rustPrims: Set<String> = [
            "u8", "u16", "u32", "u64", "u128",
            "i8", "i16", "i32", "i64", "i128",
            "f32", "f64", "bool", "char", "str"
        ]
        static let goPrims: Set<String> = [
            "int", "int8", "int16", "int32", "int64",
            "uint", "uint8", "uint16", "uint32", "uint64",
            "float32", "float64", "bool", "byte", "rune",
            "string", "complex64", "complex128"
        ]
        static let phpPrims: Set<String> = [
            "int", "integer", "float", "double", "bool", "boolean",
            "string", "array", "object", "resource", "null",
            "mixed", "void", "never", "callable", "iterable",
            "true", "false", "self", "parent", "static"
        ]
        static let tsPrims: Set<String> = [
            "any", "unknown", "never", "void",
            "null", "undefined", "object",
            "boolean", "number", "bigint", "string", "symbol"
        ]
        static let pythonPrims: Set<String> = [
            "none", "int", "float", "bool", "str", "list", "dict", "tuple", "set"
        ]

        static let universalContainers: Set<String> = [
            "array", "map", "list", "set", "dictionary", "hashmap", "hashset", "vector"
        ]
        static let tsContainers: Set<String> = [
            "array", "map", "set", "weakmap", "weakset", "readonlyarray", "promise", "record",
            "readonlymap", "readonlyset", "iterable", "iterator", "asynciterator", "generator", "readonly"
        ]
        static let csharpContainers: Set<String> = [
            "list", "dictionary", "hashset", "sortedlist", "queue", "stack"
        ]
        static let javaContainers: Set<String> = [
            "list", "arraylist", "map", "hashmap", "set", "hashset", "linkedlist", "queue"
        ]
        static let cppContainers: Set<String> = [
            "vector", "map", "unordered_map", "set", "unordered_set", "deque", "queue", "stack"
        ]
        static let rustContainers: Set<String> = [
            "vec", "hashmap", "hashset", "btreemap", "btreeset"
        ]
        static let swiftContainers: Set<String> = [
            "array", "dictionary", "set", "optional"
        ]
        static let swiftSpecialTypes: Set<String> = [
            "sendable", "error", "codable", "anyobject"
        ]
    }
    // MARK: - Method Call Removal Fix

    /// Updated so that it also removes optional `<...>` generics: e.g. `.withSettings<T>(...)`.
    static func removeMethodCalls(_ raw: String) -> String {
        // Pattern:
        //  1) A literal dot
        //  2) A valid identifier `[A-Za-z_] \w*`
        //  3) (optional) `<...>` generics
        //  4) (optional) `(...)` call
        regexReplace(RegexCache.methodCall, in: raw)
    }

    // — everything below is the same as before, except we keep the new loop approach above —

    static func removeTrailingStandaloneBrackets(_ str: String) -> String {
        var cleaned = str
        while let last = cleaned.last, "<[(:".contains(last) {
            cleaned.removeLast()
        }
        while let first = cleaned.first, ">])".contains(first) {
            cleaned.removeFirst()
        }
        return cleaned
    }

    static func stripUnmatchedAngleBrackets(_ str: String) -> String {
        var cleaned = str.trimmingCharacters(in: .whitespacesAndNewlines)

        // Preserve prior behavior for clearly unmatched cases
        while cleaned.hasSuffix(">"), !cleaned.contains("<") {
            cleaned.removeLast()
            cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        while cleaned.hasPrefix("<"), !cleaned.contains(">") {
            cleaned.removeFirst()
            cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // NEW: If we have an unclosed '<', truncate at the outermost unmatched '<'
        var depth = 0
        var outermostUnclosedAtDepth0: String.Index? = nil

        var i = cleaned.startIndex
        while i < cleaned.endIndex {
            let ch = cleaned[i]

            if ch == "<" {
                if depth == 0 {
                    outermostUnclosedAtDepth0 = i
                }
                depth += 1
            } else if ch == ">" {
                if depth > 0 {
                    depth -= 1
                    if depth == 0 {
                        // Closed the outermost generic; reset.
                        outermostUnclosedAtDepth0 = nil
                    }
                }
                // Unmatched '>' at top level — ignore (do not go negative).
            }

            i = cleaned.index(after: i)
        }

        if depth > 0, let cut = outermostUnclosedAtDepth0 {
            cleaned = String(cleaned[..<cut]).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return cleaned
    }

    static func stripPointerOptional(_ type: String, language: LanguageType) -> String {
        var cleaned = type
            .replacingOccurrences(of: "?", with: "")
            .replacingOccurrences(of: "*", with: "")
            .replacingOccurrences(of: "[]", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if language != .swift {
            cleaned = cleaned.replacingOccurrences(of: "&", with: "")
        }
        return cleaned
    }

    static func stripUnbalancedParens(_ type: String) -> String {
        var cleaned = type
        while cleaned.hasPrefix("("), !cleaned.contains(")") {
            cleaned.removeFirst()
        }
        while cleaned.hasSuffix(")"), !cleaned.contains("(") {
            cleaned.removeLast()
        }
        return cleaned
    }

    static func stripSurroundingParenPairs(_ type: String) -> String {
        var result = type.trimmingCharacters(in: .whitespacesAndNewlines)

        while result.hasPrefix("("), result.hasSuffix(")") {
            var depth = 0
            var isPerfectPair = false
            for (idx, ch) in result.enumerated() {
                if ch == "(" {
                    depth += 1
                } else if ch == ")" {
                    depth -= 1
                    if depth == 0, idx < result.count - 1 {
                        isPerfectPair = false
                        break
                    }
                    if idx == result.count - 1, depth == 0 {
                        isPerfectPair = true
                    }
                }
            }

            if isPerfectPair {
                result.removeFirst()
                result.removeLast()
            } else {
                break
            }
            result = result.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return result
    }

    static func stripTrailingBracesAndParens(_ type: String) -> String {
        var cleaned = type
        while cleaned.hasSuffix("{") || cleaned.hasSuffix("}") {
            cleaned.removeLast()
            cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        while cleaned.hasSuffix(")"), !cleaned.contains("(") {
            cleaned.removeLast()
            cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return cleaned
    }

    // MARK: - Comments

    static func removeComments(from type: String, language: LanguageType) -> String {
        var cleaned = type
        switch language {
        case .swift, .js, .c_sharp, .c, .rust, .cpp, .go, .java, .ts, .tsx, .php:
            cleaned = removeBlockComments(from: cleaned)
        case .python, .ruby:
            break
        }
        return removeInlineComments(from: cleaned, language: language)
    }

    private static func removeBlockComments(from type: String) -> String {
        var result = type
        while let start = result.range(of: "/*"),
              let end = result.range(of: "*/", range: start.upperBound ..< result.endIndex)
        {
            result.removeSubrange(start.lowerBound ..< end.upperBound)
        }
        return result
    }

    private static func removeInlineComments(from type: String, language: LanguageType) -> String {
        switch language {
        case .python, .ruby:
            if let range = type.range(of: "#") {
                return String(type[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return type
        case .php:
            let slashIndex = type.range(of: "//")?.lowerBound
            let hashIndex = type.range(of: "#")?.lowerBound
            if let cutIndex = [slashIndex, hashIndex].compactMap(\.self).min() {
                return String(type[..<cutIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return type
        default:
            if let range = type.range(of: "//") {
                return String(type[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return type
        }
    }

    // MARK: - find matching pairs

    static func findTopLevelString(in type: String, needle: String) -> String.Index? {
        guard !needle.isEmpty, type.contains(needle) else { return nil }
        let chars = Array(type)
        let needleChars = Array(needle)
        let needleCount = needleChars.count

        var bracketDepth = 0
        var parenDepth = 0
        var braceDepth = 0
        var i = 0

        while i < chars.count {
            let c = chars[i]
            switch c {
            case "<": bracketDepth += 1
            case ">": bracketDepth = max(0, bracketDepth - 1)
            case "(": parenDepth += 1
            case ")": parenDepth = max(0, parenDepth - 1)
            case "{": braceDepth += 1
            case "}": braceDepth = max(0, braceDepth - 1)
            default: break
            }
            if bracketDepth == 0, parenDepth == 0, braceDepth == 0 {
                if i + needleCount <= chars.count {
                    let slice = chars[i ..< (i + needleCount)]
                    if slice.elementsEqual(needleChars) {
                        return type.index(type.startIndex, offsetBy: i)
                    }
                }
            }
            i += 1
        }
        return nil
    }

    static func findTopLevelChar(in type: String, char: Character) -> String.Index? {
        TopLevelScanner.firstTopLevelIndex(of: char, in: type, track: .all)
    }

    static func findMatchingAngleBracket(in type: String, startIndex: String.Index) -> String.Index? {
        var count = 0
        var i = startIndex
        while i < type.endIndex {
            if type[i] == "<" {
                count += 1
            } else if type[i] == ">" {
                count -= 1
                if count == 0 {
                    return i
                }
            }
            i = type.index(after: i)
        }
        return nil
    }

    static func findMatchingParenthesis(in type: String, startIndex: String.Index) -> String.Index? {
        var count = 0
        var i = startIndex
        while i < type.endIndex {
            if type[i] == "(" {
                count += 1
            } else if type[i] == ")" {
                count -= 1
                if count == 0 {
                    return i
                }
            }
            i = type.index(after: i)
        }
        return nil
    }

    static func findMatchingSquareBracket(in type: String, startIndex: String.Index) -> String.Index? {
        var count = 0
        var i = startIndex
        while i < type.endIndex {
            if type[i] == "[" {
                count += 1
            } else if type[i] == "]" {
                count -= 1
                if count == 0 {
                    return i
                }
            }
            i = type.index(after: i)
        }
        return nil
    }

    // MARK: - Splitting

    static func splitByTopLevelCommas(_ input: String) -> [String] {
        let ranges = TopLevelScanner.splitTopLevel(input, separator: ",", track: .all)
        return ranges.map {
            input[$0].trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.isEmpty }
    }

    static func splitByTopLevelColon(_ input: String) -> [String] {
        let ranges = TopLevelScanner.splitTopLevel(input, separator: ":", track: .all)
        return ranges.map {
            input[$0].trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.isEmpty }
    }

    static func splitSwiftIntersections(_ input: String) -> [String] {
        let ranges = TopLevelScanner.splitTopLevel(input, operators: ["&"], track: .all)
        return ranges.map {
            input[$0].trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.isEmpty }
    }

    // MARK: - TS union & intersection splits

    static func splitTSUnionsAndIntersections(_ input: String) -> [String] {
        let unionPieces = splitByTopLevelOperator(input, operators: ["|"])
        var result: [String] = []
        for piece in unionPieces {
            let intersectionPieces = splitByTopLevelOperator(piece, operators: ["&"])
            result.append(contentsOf: intersectionPieces)
        }
        return result
    }

    static func splitByTopLevelOperator(_ input: String, operators: [Character]) -> [String] {
        let ranges = TopLevelScanner.splitTopLevel(
            input,
            operators: Set(operators),
            track: .all
        )
        return ranges.map {
            input[$0].trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.isEmpty }
    }

    // MARK: - Opaque / ephemeral / container checks

    static func removeOpaqueTypeKeyword(from type: String, language: LanguageType) -> String {
        guard language == .swift else { return type }
        return regexReplace(RegexCache.swiftOpaque, in: type).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func normalizeSwiftType(_ type: String) -> String {
        var cleaned = type
        cleaned = regexReplace(RegexCache.swiftAttributes, in: cleaned)
        cleaned = regexReplace(RegexCache.swiftKeywords, in: cleaned)
        cleaned = cleaned.replacingOccurrences(of: "...", with: "")
        cleaned = regexReplace(RegexCache.multiWhitespace, in: cleaned, with: " ")
        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - PCRE2 Regex Cache

    /// Cached PCRE2 patterns for type cleaning operations.
    enum RegexCache {
        /// Matches method calls like `.foo()`, `.bar<T>()` (requires parens to avoid stripping namespaces).
        static let methodCall = CodeMapPCRE2Pattern(#"\.[A-Za-z_][A-Za-z0-9_]*(<[^>]*>)?\([^)]*\)"#)

        /// Matches Swift opaque type keywords: `some Type` or `any Type`.
        static let swiftOpaque = CodeMapPCRE2Pattern(#"^\s*(some|any)\s+"#, caseInsensitive: true)

        /// Matches Swift attributes like @escaping, @Sendable, @available(...).
        static let swiftAttributes = CodeMapPCRE2Pattern(#"@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?"#)

        /// Matches Swift keywords that can appear in type positions.
        static let swiftKeywords = CodeMapPCRE2Pattern(#"\b(?:async|throws|rethrows|inout|borrowing|consuming|isolated|nonisolated|some|any)\b"#)

        /// Matches multiple whitespace characters.
        static let multiWhitespace = CodeMapPCRE2Pattern(#"\s+"#)

        /// Matches TypeScript `keyof` operator.
        static let tsKeyof = CodeMapPCRE2Pattern(#"\bkeyof\s+"#)

        /// Matches TypeScript `typeof` operator.
        static let tsTypeof = CodeMapPCRE2Pattern(#"\btypeof\s+"#)

        /// Matches TypeScript `readonly` modifier.
        static let tsReadonly = CodeMapPCRE2Pattern(#"\breadonly\s+"#)
    }

    /// Replaces all matches of the regex in the text with the replacement string.
    static func regexReplace(_ regex: CodeMapPCRE2Pattern, in text: String, with replacement: String = "") -> String {
        regex.replacingMatches(in: text, with: replacement)
    }

    static func filterOutPrimitiveAndSpecialTypes(_ extracted: [String], language: LanguageType) -> [String] {
        var results: [String] = []

        for raw in extracted {
            let subTypes = expandTupleTypes(raw)
            for s in subTypes {
                var cleaned = stripUnbalancedParens(s).trimmingCharacters(in: .whitespacesAndNewlines)
                if language == .swift {
                    cleaned = stripSwiftTupleLabel(cleaned)
                } else if language == .ts || language == .tsx {
                    cleaned = stripTSParamLabelAndDefault(cleaned)
                }

                if language == .ts || language == .tsx, isTSLiteralType(cleaned) {
                    continue
                }

                if language == .ts || language == .tsx, cleaned.hasPrefix("{") {
                    let extractedObjectTypes = extractTSObjectLiteralTypes(from: cleaned, language: language)
                    results.append(contentsOf: extractedObjectTypes)
                    continue
                }
                if cleaned.contains("{") || cleaned.contains("}") || cleaned.contains("\n") {
                    continue
                }

                // ephemeral for Swift
                if language == .swift, isEphemeralSwiftType(cleaned) {
                    continue
                }
                if language == .swift, isSwiftSpecialType(cleaned) {
                    continue
                }
                if isPrimitiveType(cleaned, language: language) {
                    continue
                }
                if isContainerType(cleaned, language: language) {
                    continue
                }
                if language == .ts || language == .tsx,
                   cleaned == "React.Component" || cleaned == "React.PureComponent"
                {
                    continue
                }
                if isGenericPlaceholder(cleaned, language: language) {
                    continue
                }

                let lower = cleaned.lowercased()
                if ["untyped", "varargs", "enum", "union"].contains(lower) {
                    continue
                }

                if cleaned.hasSuffix(":") {
                    cleaned.removeLast()
                    cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
                }

                if !cleaned.isEmpty {
                    results.append(cleaned)
                }
            }
        }
        return Array(Set(results))
    }

    static func filterOutPrimitiveAndSpecialTypesCached(
        _ extracted: [String],
        language: LanguageType,
        cache: inout [TypeCleanerCacheKey: [String]],
        stats: CodeMapPerformanceCollector?
    ) -> [String] {
        let filterStart = stats == nil ? 0 : CFAbsoluteTimeGetCurrent()
        defer {
            if let stats {
                recordTypeCleanerPhase(.filter, duration: CFAbsoluteTimeGetCurrent() - filterStart, stats: stats)
            }
        }
        var results: [String] = []

        for raw in extracted {
            let subTypes = expandTupleTypes(raw)
            for s in subTypes {
                var cleaned = stripUnbalancedParens(s).trimmingCharacters(in: .whitespacesAndNewlines)
                if language == .swift {
                    cleaned = stripSwiftTupleLabel(cleaned)
                } else if language == .ts || language == .tsx {
                    cleaned = stripTSParamLabelAndDefault(cleaned)
                }

                if language == .ts || language == .tsx, isTSLiteralType(cleaned) {
                    continue
                }

                if language == .ts || language == .tsx, cleaned.hasPrefix("{") {
                    let extractedObjectTypes = extractTSObjectLiteralTypesCached(
                        from: cleaned,
                        language: language,
                        cache: &cache,
                        stats: stats
                    )
                    results.append(contentsOf: extractedObjectTypes)
                    continue
                }
                if cleaned.contains("{") || cleaned.contains("}") || cleaned.contains("\n") {
                    continue
                }

                // ephemeral for Swift
                if language == .swift, isEphemeralSwiftType(cleaned) {
                    continue
                }
                if language == .swift, isSwiftSpecialType(cleaned) {
                    continue
                }
                if isPrimitiveType(cleaned, language: language) {
                    continue
                }
                if isContainerType(cleaned, language: language) {
                    continue
                }
                if language == .ts || language == .tsx,
                   cleaned == "React.Component" || cleaned == "React.PureComponent"
                {
                    continue
                }
                if isGenericPlaceholder(cleaned, language: language) {
                    continue
                }

                let lower = cleaned.lowercased()
                if ["untyped", "varargs", "enum", "union"].contains(lower) {
                    continue
                }

                if cleaned.hasSuffix(":") {
                    cleaned.removeLast()
                    cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
                }

                if !cleaned.isEmpty {
                    results.append(cleaned)
                }
            }
        }
        let dedupStart = stats == nil ? 0 : CFAbsoluteTimeGetCurrent()
        let deduped = Array(Set(results))
        if let stats {
            recordTypeCleanerPhase(.dedup, duration: CFAbsoluteTimeGetCurrent() - dedupStart, stats: stats)
        }
        return deduped
    }

    private static func isGenericPlaceholder(_ typeName: String, language: LanguageType) -> Bool {
        switch language {
        case .swift, .ts, .tsx:
            let trimmed = typeName.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.count == 1, let first = trimmed.first, first.isUppercase {
                return true
            }
            return ["T", "U", "V", "K", "E", "R", "S"].contains(trimmed)
        default:
            return false
        }
    }

    static func isGenericPlaceholderTypeName(_ typeName: String, language: LanguageType) -> Bool {
        isGenericPlaceholder(typeName, language: language)
    }

    private static func stripSwiftTupleLabel(_ typeName: String) -> String {
        guard findTopLevelChar(in: typeName, char: ":") != nil else { return typeName }
        let parts = splitByTopLevelColon(typeName)
        guard let last = parts.last else { return typeName }
        return last.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func expandTupleTypes(_ rawType: String) -> [String] {
        let t = rawType.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("("), t.hasSuffix(")"), t.count >= 2 else {
            return [t]
        }
        let inner = t.dropFirst().dropLast()
        let parts = inner.split(separator: ",")
        return parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    private static func isEphemeralSwiftType(_ type: String) -> Bool {
        let lower = type.lowercased()
        return lower == "()" ||
            lower == "void" ||
            lower == "never" ||
            lower == "any"
    }

    private static func isSwiftSpecialType(_ type: String) -> Bool {
        let lower = type.lowercased()
        let base = lower.split(separator: ".").last.map(String.init) ?? lower
        return TypeCleanerSets.swiftSpecialTypes.contains(base)
    }

    static func isSwiftSpecialTypeName(_ typeName: String) -> Bool {
        isSwiftSpecialType(typeName)
    }

    static func isPrimitiveType(_ typeName: String, language: LanguageType) -> Bool {
        let lower = typeName.lowercased()
        switch language {
        case .swift:
            return TypeCleanerSets.swiftPrims.contains(lower)

        case .c_sharp:
            return TypeCleanerSets.csharpPrims.contains(lower)

        case .java:
            return TypeCleanerSets.javaPrims.contains(lower)

        case .c, .cpp:
            return TypeCleanerSets.cPrims.contains(lower)

        case .python:
            let typeWithoutGeneric = lower.components(separatedBy: "[").first ?? lower
            return TypeCleanerSets.pythonPrims.contains(typeWithoutGeneric)

        case .rust:
            return TypeCleanerSets.rustPrims.contains(lower)

        case .go:
            return TypeCleanerSets.goPrims.contains(lower)

        case .js:
            // define if needed
            return false

        case .ruby:
            return false

        case .php: // ➜ NEW
            return TypeCleanerSets.phpPrims.contains(lower)

        case .ts, .tsx:
            return TypeCleanerSets.tsPrims.contains(lower)
        }
    }

    static func isContainerType(_ typeName: String, language: LanguageType) -> Bool {
        let lower = typeName.lowercased()

        switch language {
        case .ts, .tsx:
            return TypeCleanerSets.universalContainers.contains(lower) || TypeCleanerSets.tsContainers.contains(lower)

        case .c_sharp:
            return TypeCleanerSets.universalContainers.contains(lower) || TypeCleanerSets.csharpContainers.contains(lower)

        case .java:
            return TypeCleanerSets.universalContainers.contains(lower) || TypeCleanerSets.javaContainers.contains(lower)

        case .c, .cpp:
            return TypeCleanerSets.universalContainers.contains(lower) || TypeCleanerSets.cppContainers.contains(lower)

        case .python:
            return TypeCleanerSets.universalContainers.contains(lower) || ["list", "dict", "set"].contains(lower)

        case .rust:
            return TypeCleanerSets.universalContainers.contains(lower) || TypeCleanerSets.rustContainers.contains(lower)

        case .go:
            return TypeCleanerSets.universalContainers.contains(lower) || (lower == "map")

        case .swift:
            return TypeCleanerSets.universalContainers.contains(lower) || TypeCleanerSets.swiftContainers.contains(lower)

        case .js:
            return false

        case .php: // ➜ NEW
            return TypeCleanerSets.universalContainers.contains(lower)

        case .ruby:
            return TypeCleanerSets.universalContainers.contains(lower)
        }
    }
}
