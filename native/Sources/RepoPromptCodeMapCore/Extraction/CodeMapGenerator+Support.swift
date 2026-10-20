// Modified for mipmux: extraction state and capture handlers separated.
import Foundation
import CoreFoundation
import SwiftTreeSitter

extension CodeMapGenerator {
    struct LineCache {
        private struct RangeCacheKey: Hashable {
            let location: Int
            let length: Int

            init(_ range: NSRange) {
                location = range.location
                length = range.length
            }
        }

        let nsContent: NSString
        let boundaries: [Int]
        let contentLength: Int
        var rangeCache: [Int: NSRange] = [:]
        var lineCache: [Int: String] = [:]
        var trimmedCache: [Int: String] = [:]
        private var coveringRangeCache: [RangeCacheKey: NSRange] = [:]
        private var coveringLineCache: [RangeCacheKey: String] = [:]
        private var coveringTrimmedCache: [RangeCacheKey: String] = [:]

        init(nsContent: NSString, boundaries: [Int], contentLength: Int) {
            self.nsContent = nsContent
            self.boundaries = boundaries
            self.contentLength = contentLength
        }

        mutating func lineIndex(for location: Int) -> Int {
            CodeMapGenerator.lineIndex(for: location, using: boundaries)
        }

        mutating func range(for location: Int) -> NSRange {
            let idx = lineIndex(for: location)
            if let cached = rangeCache[idx] { return cached }
            let start = boundaries[idx]
            let end = (idx + 1 < boundaries.count) ? boundaries[idx + 1] : contentLength
            let range = NSRange(location: start, length: end - start)
            rangeCache[idx] = range
            return range
        }

        mutating func range(covering range: NSRange) -> NSRange {
            let key = RangeCacheKey(range)
            if let cached = coveringRangeCache[key] { return cached }
            let startIdx = lineIndex(for: range.location)
            let endLocation = max(range.location, NSMaxRange(range) - 1)
            let endIdx = lineIndex(for: endLocation)
            let start = boundaries[startIdx]
            let end = (endIdx + 1 < boundaries.count) ? boundaries[endIdx + 1] : contentLength
            let coveringRange = NSRange(location: start, length: end - start)
            coveringRangeCache[key] = coveringRange
            return coveringRange
        }

        mutating func line(for location: Int) -> String {
            let idx = lineIndex(for: location)
            if let cached = lineCache[idx] { return cached }
            let line = nsContent.substring(with: range(for: location))
            lineCache[idx] = line
            return line
        }

        mutating func line(covering range: NSRange) -> String {
            let key = RangeCacheKey(range)
            if let cached = coveringLineCache[key] { return cached }
            let line = nsContent.substring(with: self.range(covering: range))
            coveringLineCache[key] = line
            return line
        }

        mutating func trimmedLine(for location: Int) -> String {
            let idx = lineIndex(for: location)
            if let cached = trimmedCache[idx] { return cached }
            let trimmed = line(for: location).trimmingCharacters(in: .whitespacesAndNewlines)
            trimmedCache[idx] = trimmed
            return trimmed
        }

        mutating func trimmedLine(covering range: NSRange) -> String {
            let key = RangeCacheKey(range)
            if let cached = coveringTrimmedCache[key] { return cached }
            let trimmed = line(covering: range).trimmingCharacters(in: .whitespacesAndNewlines)
            coveringTrimmedCache[key] = trimmed
            return trimmed
        }
    }

    static func binarySearchFirstFalse(count: Int, predicate: (Int) -> Bool) -> Int {
        var low = 0
        var high = count
        while low < high {
            let mid = (low + high) / 2
            if predicate(mid) {
                low = mid + 1
            } else {
                high = mid
            }
        }
        return low
    }

    static func isBetterRange(_ candidate: NSRange, than current: NSRange) -> Bool {
        if candidate.length != current.length {
            return candidate.length < current.length
        }
        return candidate.location < current.location
    }

    /// Precomputes the starting indices of each line in the content.
    /// Matches read_file semantics by treating \r, \n, and \r\n as line endings.
    static func computeLineBoundaries(content: String) -> [Int] {
        let utf16 = content.utf16
        var boundaries = [0]
        var idx = utf16.startIndex
        var offset = 0
        while idx < utf16.endIndex {
            let unit = utf16[idx]
            if unit == 13 { // \r
                let next = utf16.index(after: idx)
                if next < utf16.endIndex, utf16[next] == 10 {
                    // CRLF
                    idx = utf16.index(after: next)
                    offset += 2
                } else {
                    idx = next
                    offset += 1
                }
                boundaries.append(offset)
                continue
            } else if unit == 10 { // \n
                idx = utf16.index(after: idx)
                offset += 1
                boundaries.append(offset)
                continue
            }
            idx = utf16.index(after: idx)
            offset += 1
        }
        return boundaries
    }

    /// Returns the 0-indexed line index for a given location using precomputed boundaries.
    private static func lineIndex(for location: Int, using boundaries: [Int]) -> Int {
        var low = 0
        var high = boundaries.count - 1
        var result = 0
        while low <= high {
            let mid = (low + high) / 2
            if boundaries[mid] <= location {
                result = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return result
    }

    /// Returns the 1-indexed line number for a given location using precomputed boundaries.
    static func lineNumber(for location: Int, using boundaries: [Int]) -> Int {
        lineIndex(for: location, using: boundaries) + 1
    }

    static func jstsContextForVariableDecl(_ decl: String) -> JSTSSignatureContext {
        let trimmed = decl.trimmingCharacters(in: .whitespacesAndNewlines)
        if TopLevelScanner.containsTopLevel("=>", in: trimmed, track: .all) {
            return .functionLike
        }
        return .statementLike
    }

    /// Returns the full declaration line (plus any indented continuations) for a capture.
    /// For TS/TSX, use context-aware signature extraction that handles type literals correctly.
    static func captureDeclaration(
        nsContent: NSString,
        for range: NSRange,
        lineRange: NSRange,
        terminator: Character,
        jsTsContext: JSTSSignatureContext? = nil,
        returnRawJSTS: Bool = false,
        perfStats: CodeMapPerformanceCollector? = nil,
        perfOptions: CodeMapPerfOptions = .disabled
    ) -> String {
        let activePerfOptions = perfOptions
        let activePerfStats = perfStats
        let perfEnabled = activePerfOptions.enabled
        let perfCollectCounters = activePerfOptions.collectCounters
        if perfCollectCounters {
            activePerfStats?.captureDeclarationCalls += 1
        }
        let start = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
        defer {
            if perfEnabled {
                activePerfStats?.captureDeclarationDuration += (CFAbsoluteTimeGetCurrent() - start)
            }
        }
        let currentLineRange = lineRange
        var declaration = nsContent.substring(with: currentLineRange)
        let trimmedDeclaration = declaration.trimmingCharacters(in: .whitespaces)
        let isJSTS = returnRawJSTS || (jsTsContext != nil)
        if isJSTS {
            let context = jsTsContext ?? .statementLike
            let assembled = captureJSTSDeclaration(
                nsContent: nsContent,
                startRange: currentLineRange,
                context: context
            )
            if let context = jsTsContext, !returnRawJSTS {
                return JSTSSignatureExtractor.extract(
                    from: assembled,
                    context: context,
                    perfStats: activePerfStats,
                    perfOptions: activePerfOptions
                )
            }
            return assembled
        }

        // For Ruby, keep declaration to a single line (no multiline continuation).
        if terminator == "\0" {
            return declaration.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // For Python function definitions (a "def " line with a ":" terminator),
        // find the matching closing parenthesis and then the colon.
        if terminator == ":", trimmedDeclaration.hasPrefix("def ") || trimmedDeclaration.hasPrefix("async def ") {
            if let parenStart = declaration.firstIndex(of: "("),
               let matchingParen = findMatchingParenthesis(in: declaration, startingAt: parenStart)
            {
                let searchRange = declaration.index(after: matchingParen) ..< declaration.endIndex
                if let colonIndex = declaration[searchRange].firstIndex(of: ":") {
                    declaration = String(declaration[..<colonIndex]) + ":"
                    return declaration.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            }
        }

        // Fallback: if the terminator exists anywhere in the line, truncate there.
        // NOTE: JS/TS use JSTSSignatureExtractor above, so this fallback is for other languages.
        // We do NOT use the semicolon heuristic here - that was JS/TS-specific and caused body
        // leakage in languages like Swift, C#, etc. where semicolons appear in string literals.
        if !isJSTS {
            let termIndex = (terminator == "{")
                ? findTopLevelBrace(in: declaration)
                : declaration.firstIndex(of: terminator)
            if let termIndex {
                // Truncate at the terminator (don't include `{` for brace-delimited languages)
                if terminator == "{" {
                    declaration = String(declaration[..<termIndex])
                } else {
                    declaration = String(declaration[..<termIndex]) + String(terminator)
                }
                return declaration.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        // Fix 1: Capture multiline declarations correctly
        // After we've grabbed the current line, extend across indented continuation lines.
        let baseIndent = declaration.prefix(while: { $0.isWhitespace }).count
        var nextLocation = currentLineRange.upperBound

        while nextLocation < nsContent.length {
            let nextLineRange = nsContent.lineRange(for: NSRange(location: nextLocation, length: 0))
            let nextLine = nsContent.substring(with: nextLineRange)
            let trimmedNext = nextLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedNext.isEmpty || (trimmedNext.first == terminator) { break }
            if trimmedNext.first == ":", declaration.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix(")") {
                break
            }

            if !isJSTS, terminator == "{" {
                let state = parenState(in: declaration)
                if state.sawParen, state.depth == 0 {
                    break
                }
            }

            let nextIndent = nextLine.prefix(while: { $0.isWhitespace }).count
            if nextIndent > baseIndent {
                if isJSTS {
                    declaration += "\n" + trimmedNext
                } else {
                    declaration += " " + trimmedNext
                }
                if !isJSTS {
                    let termIndex = (terminator == "{")
                        ? findTopLevelBrace(in: declaration)
                        : declaration.firstIndex(of: terminator)
                    if let termIndex {
                        // For TypeScript/JavaScript, don't include the opening brace
                        if terminator == "{" {
                            declaration = String(declaration[..<termIndex])
                        } else {
                            declaration = String(declaration[..<termIndex]) + String(terminator)
                        }
                        break
                    }
                }
                nextLocation = nextLineRange.upperBound
            } else {
                break
            }
        }

        return declaration.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func captureJSTSDeclaration(
        nsContent: NSString,
        startRange: NSRange,
        context: JSTSSignatureContext
    ) -> String {
        var declaration = nsContent.substring(with: startRange)
        let baseIndent = declaration.prefix(while: { $0.isWhitespace }).count
        var nextLocation = startRange.upperBound
        var linesAdded = 0

        while nextLocation < nsContent.length, linesAdded < jstsMaxAppendedContinuationLines {
            let trimmedDecl = declaration.trimmingCharacters(in: .whitespacesAndNewlines)
            switch context {
            case .functionLike:
                if isJSTSFunctionSignatureComplete(trimmedDecl) { return trimmedDecl }
            case .statementLike:
                break
            }

            let nextLineRange = nsContent.lineRange(for: NSRange(location: nextLocation, length: 0))
            let nextLine = nsContent.substring(with: nextLineRange)
            let trimmedNext = nextLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedNext.isEmpty { break }
            let nextIndent = nextLine.prefix(while: { $0.isWhitespace }).count

            if context == .statementLike {
                let needsBraceContinuation = jstsNeedsBraceContinuation(trimmedDecl)
                if nextIndent <= baseIndent, !needsBraceContinuation { break }
            }

            declaration += "\n" + trimmedNext
            nextLocation = nextLineRange.upperBound
            linesAdded += 1
        }

        return declaration.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isJSTSFunctionSignatureComplete(_ declaration: String) -> Bool {
        let trimmed = declaration.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let hasAssignment = jstsTopLevelAssignmentIndex(in: trimmed) != nil
        let looksLikeVarDecl = jstsLooksLikeVariableDecl(trimmed)
        if TopLevelScanner.containsTopLevel("=>", in: trimmed, track: .all) {
            return true
        }
        if hasAssignment || looksLikeVarDecl {
            if TopLevelScanner.firstTopLevelIndex(of: ";", in: trimmed, track: .all) != nil {
                return true
            }
            return false
        }
        if let returnType = LanguageTypeExtractor.TS.extractReturnType(from: trimmed),
           returnType.hasPrefix("{"),
           !returnType.hasSuffix("}")
        {
            return false
        }
        if TopLevelScanner.firstTopLevelIndex(of: "{", in: trimmed, track: .all) != nil {
            return true
        }
        if TopLevelScanner.firstTopLevelIndex(of: ";", in: trimmed, track: .all) != nil {
            return true
        }
        return false
    }

    private static func jstsLooksLikeVariableDecl(_ declaration: String) -> Bool {
        var trimmed = declaration.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefixes = ["export default ", "export ", "declare "]
        for prefix in prefixes {
            if trimmed.hasPrefix(prefix) {
                trimmed = String(trimmed.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                break
            }
        }
        return trimmed.hasPrefix("const ") || trimmed.hasPrefix("let ") || trimmed.hasPrefix("var ")
    }

    private static func jstsNeedsBraceContinuation(_ declaration: String) -> Bool {
        let trimmed = declaration.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return false }
        return jstsTopLevelBraceDepth(in: Substring(trimmed)) > 0
    }

    private static func jstsTopLevelAssignmentIndex(in text: String) -> String.Index? {
        var angleDepth = 0
        var parenDepth = 0
        var braceDepth = 0
        var bracketDepth = 0
        var i = text.startIndex
        while i < text.endIndex {
            let ch = text[i]
            switch ch {
            case "<": angleDepth += 1
            case ">": angleDepth = max(0, angleDepth - 1)
            case "(": parenDepth += 1
            case ")": parenDepth = max(0, parenDepth - 1)
            case "{": braceDepth += 1
            case "}": braceDepth = max(0, braceDepth - 1)
            case "[": bracketDepth += 1
            case "]": bracketDepth = max(0, bracketDepth - 1)
            case "=":
                if angleDepth == 0, parenDepth == 0, braceDepth == 0, bracketDepth == 0 {
                    let next = text.index(after: i)
                    if next < text.endIndex {
                        let nextChar = text[next]
                        if nextChar == ">" || nextChar == "=" {
                            i = next
                            continue
                        }
                    }
                    return i
                }
            default: break
            }
            i = text.index(after: i)
        }
        return nil
    }

    private static func jstsTopLevelBraceDepth(in text: Substring) -> Int {
        var angleDepth = 0
        var parenDepth = 0
        var bracketDepth = 0
        var braceDepth = 0
        var i = text.startIndex
        while i < text.endIndex {
            let ch = text[i]
            switch ch {
            case "<": angleDepth += 1
            case ">": angleDepth = max(0, angleDepth - 1)
            case "(": parenDepth += 1
            case ")": parenDepth = max(0, parenDepth - 1)
            case "[": bracketDepth += 1
            case "]": bracketDepth = max(0, bracketDepth - 1)
            case "{":
                if angleDepth == 0, parenDepth == 0, bracketDepth == 0 { braceDepth += 1 }
            case "}":
                if angleDepth == 0, parenDepth == 0, bracketDepth == 0, braceDepth > 0 {
                    braceDepth -= 1
                }
            default: break
            }
            i = text.index(after: i)
        }
        return braceDepth
    }

    private static func findMatchingParenthesis(in string: String, startingAt start: String.Index) -> String.Index? {
        var count = 0
        var index = start
        while index < string.endIndex {
            let ch = string[index]
            if ch == "(" {
                count += 1
            } else if ch == ")" {
                count -= 1
                if count == 0 { return index }
            }
            index = string.index(after: index)
        }
        return nil
    }

    private static func findTopLevelBrace(in string: String) -> String.Index? {
        var parenDepth = 0
        var bracketDepth = 0
        var inString: Character? = nil
        var escaped = false
        var inBlockComment = false
        var index = string.startIndex

        while index < string.endIndex {
            let ch = string[index]

            if inBlockComment {
                if ch == "*" {
                    let nextIndex = string.index(after: index)
                    if nextIndex < string.endIndex, string[nextIndex] == "/" {
                        inBlockComment = false
                        index = string.index(after: nextIndex)
                        continue
                    }
                }
                index = string.index(after: index)
                continue
            }

            if let stringDelimiter = inString {
                if escaped {
                    escaped = false
                } else if ch == "\\" {
                    escaped = true
                } else if ch == stringDelimiter {
                    inString = nil
                }
                index = string.index(after: index)
                continue
            }

            if ch == "\"" || ch == "'" {
                inString = ch
                index = string.index(after: index)
                continue
            }

            if ch == "/" {
                let nextIndex = string.index(after: index)
                if nextIndex < string.endIndex {
                    let nextChar = string[nextIndex]
                    if nextChar == "/" {
                        break
                    }
                    if nextChar == "*" {
                        inBlockComment = true
                        index = string.index(after: nextIndex)
                        continue
                    }
                }
            }

            switch ch {
            case "(":
                parenDepth += 1
            case ")":
                parenDepth = max(0, parenDepth - 1)
            case "[":
                bracketDepth += 1
            case "]":
                bracketDepth = max(0, bracketDepth - 1)
            case "{":
                if parenDepth == 0, bracketDepth == 0 {
                    return index
                }
            default:
                break
            }
            index = string.index(after: index)
        }

        return nil
    }

    private static func parenState(in string: String) -> (depth: Int, sawParen: Bool) {
        var parenDepth = 0
        var sawParen = false
        var inString: Character? = nil
        var escaped = false
        var inBlockComment = false
        var index = string.startIndex

        while index < string.endIndex {
            let ch = string[index]

            if inBlockComment {
                if ch == "*" {
                    let nextIndex = string.index(after: index)
                    if nextIndex < string.endIndex, string[nextIndex] == "/" {
                        inBlockComment = false
                        index = string.index(after: nextIndex)
                        continue
                    }
                }
                index = string.index(after: index)
                continue
            }

            if let stringDelimiter = inString {
                if escaped {
                    escaped = false
                } else if ch == "\\" {
                    escaped = true
                } else if ch == stringDelimiter {
                    inString = nil
                }
                index = string.index(after: index)
                continue
            }

            if ch == "\"" || ch == "'" {
                inString = ch
                index = string.index(after: index)
                continue
            }

            if ch == "/" {
                let nextIndex = string.index(after: index)
                if nextIndex < string.endIndex {
                    let nextChar = string[nextIndex]
                    if nextChar == "/" {
                        break
                    }
                    if nextChar == "*" {
                        inBlockComment = true
                        index = string.index(after: nextIndex)
                        continue
                    }
                }
            }

            switch ch {
            case "(":
                parenDepth += 1
                sawParen = true
            case ")":
                parenDepth = max(0, parenDepth - 1)
                sawParen = true
            default:
                break
            }

            index = string.index(after: index)
        }

        return (depth: parenDepth, sawParen: sawParen)
    }

    /// Extracts a substring from content using an NSRange.
    static func substring(content: String, range: NSRange) -> String {
        guard range.location != NSNotFound,
              let swiftRange = Range(range, in: content) else { return "" }
        return String(content[swiftRange])
    }

    /// Helper to map file extensions to our SupportedLang enum.
    private static func supportedLang(for fileExtension: String) -> LanguageType? {
        switch fileExtension {
        case "swift": .swift
        case "cs": .c_sharp
        case "java": .java
        case "c": .c
        case "cpp": .cpp
        case "py": .python
        case "js": .js
        case "go": .go
        case "rs": .rust
        case "ts": .ts
        case "tsx": .tsx
        case "php": .php
        case "rb": .ruby
        default: nil
        }
    }

    /// Extracts a clean function name for TS/TSX from the capture text or declaration.
    /// Handles: identifiers, member expressions (Tabs.List), const/let/var declarations, function declarations.
    static func extractJSTSFunctionName(captureText: String, decl: String) -> String {
        let cap = captureText.trimmingCharacters(in: .whitespacesAndNewlines)

        // If capture is already a clean identifier or dotted member expression, use it directly
        if let _ = firstRegexGroup(RegexCache.jstsIdentifierOrMember, in: cap) {
            return cap
        }

        // const/let/var Name = ... or const/let/var Name: Type = ...
        if let name = firstRegexGroup(RegexCache.jstsVarDeclName, in: decl) {
            return name
        }

        // function Name(...) or async function Name(...)
        if let name = firstRegexGroup(RegexCache.jstsFunctionDeclName, in: decl) {
            return name
        }

        // Tabs.List = ... (property assignment)
        if let name = firstRegexGroup(RegexCache.jstsPropAssignmentName, in: decl) {
            return name
        }

        // Fallback: return the full declaration
        return decl
    }

    /// Extracts a clean variable name for JS/TS global variables.
    static func extractJSTSVariableName(from decl: String) -> String? {
        let trimmed = decl.trimmingCharacters(in: .whitespacesAndNewlines)
        // const/let/var Name ... (unicode-friendly)
        if let name = firstRegexGroup(RegexCache.jstsGlobalVarName, in: trimmed) {
            return name
        }
        return nil
    }

    /// Extracts a clean variable name for Go global variables.
    static func extractGoVariableName(captureText: String, decl: String) -> String? {
        let cap = captureText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cap.isEmpty, !containsWhitespace(cap) {
            return cap
        }
        if let name = firstRegexGroup(RegexCache.cOrGoVarName, in: decl) {
            return name
        }
        return nil
    }

    /// Extracts a clean variable name for C global variables.
    static func extractCVariableName(captureText: String, decl: String) -> String? {
        let cap = captureText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cap.isEmpty, !containsWhitespace(cap) {
            return cap
        }
        if let name = firstRegexGroup(RegexCache.cOrGoVarName, in: decl) {
            return name
        }
        return nil
    }

    // MARK: - PCRE2 Regex Cache

    /// Cached PCRE2 patterns for identifier and declaration extraction.
    /// Uses Unicode character classes for broad language support.
    enum RegexCache {
        /// Matches a simple identifier: starts with letter/underscore/$, followed by alphanumerics.
        static let simpleIdentifier = CodeMapPCRE2Pattern(#"^([\p{L}_$][\p{L}\p{N}_$]*)$"#)

        /// Matches Go receiver type: func (receiver) methodName.
        static let goReceiverType = CodeMapPCRE2Pattern(#"func\s*\(([^)]*)\)\s+[\p{L}_][\p{L}\p{N}_]*"#)

        /// Matches JS/TS identifier or member expression: foo or foo.bar.baz.
        static let jstsIdentifierOrMember = CodeMapPCRE2Pattern(#"^([\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*)$"#)

        /// Matches JS/TS variable declaration name: (export)? (default)? (const|let|var) Name.
        static let jstsVarDeclName = CodeMapPCRE2Pattern(#"(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)"#)

        /// Matches JS/TS function declaration name: (export)? (default)? (async)? function Name.
        static let jstsFunctionDeclName = CodeMapPCRE2Pattern(#"(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([\p{L}_$][\p{L}\p{N}_$]*)"#)

        /// Matches JS/TS property assignment: Foo.Bar.Baz =.
        static let jstsPropAssignmentName = CodeMapPCRE2Pattern(#"^([\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)+)\s*="#)

        /// Matches JS/TS global variable name: (export)? (declare)? (const|let|var) Name.
        static let jstsGlobalVarName = CodeMapPCRE2Pattern(#"(?:^|\s)(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)"#)

        /// Matches C/Go variable name at start of string.
        /// Note: Intentionally ASCII-only - C/Go identifiers are ASCII by language spec.
        static let cOrGoVarName = CodeMapPCRE2Pattern(#"^([A-Za-z_][A-Za-z0-9_]*)"#)

        /// Matches Python enum base classes.
        static let pythonEnumClass = CodeMapPCRE2Pattern(#"\b(Enum|IntEnum|StrEnum)\b"#)

        /// Matches uppercase snake case (for Python enum members).
        static let upperSnakeCase = CodeMapPCRE2Pattern(#"^[A-Z][A-Z0-9_]*$"#)

        /// Matches JS/TS variable name extraction: (export)? (const|let|var) Name.
        static let jstsVarNameExtract = CodeMapPCRE2Pattern(#"(?:export\s+)?(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)"#)
    }

    /// Returns the first capture group from a PCRE2 match, or nil if no match.
    @inline(__always)
    static func firstRegexGroup(_ regex: CodeMapPCRE2Pattern, in text: String) -> String? {
        regex.firstCapture(1, in: text)
    }

    /// Checks if text contains any whitespace characters.
    @inline(__always)
    static func containsWhitespace(_ text: String) -> Bool {
        text.contains(where: \.isWhitespace)
    }
}
