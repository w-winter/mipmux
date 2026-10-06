// Modified for smip: declarations relocated and cross-file access adjusted.
import Foundation
import CoreFoundation

extension LanguageTypeExtractor {
    // MARK: - Inline Regex Helpers (typed outputs for compile-time safety)

    /// C-style parameter decorators to remove (out, ref, in, const, etc.)
    /// Output: (wholeMatch, decorator)
    private nonisolated(unsafe) static let cStyleDecoratorRegex: Regex<(Substring, Substring)> = #/\b(out|ref|in|const|volatile|mutable|inout|__owned|__borrowed)\b/#

    /// Match last whitespace-separated word (for separating type from name)
    /// Output: wholeMatch only
    private nonisolated(unsafe) static let lastWordSeparatorRegex: Regex<Substring> = #/\s+[^\s]+$/#

    /// Swift parameter decorators to remove (inout, __owned, etc.)
    /// Output: (wholeMatch, decorator)
    private nonisolated(unsafe) static let swiftDecoratorRegex: Regex<(Substring, Substring)> = #/\b(inout|__owned|__shared|__borrowed)\b/#

    /// Rust parameter decorators to remove (mut, ref)
    /// Output: (wholeMatch, decorator)
    private nonisolated(unsafe) static let rustDecoratorRegex: Regex<(Substring, Substring)> = #/\b(mut|ref)\b/#

    /// Multiple whitespace to normalize to single space
    /// Output: wholeMatch only
    private nonisolated(unsafe) static let multiWhitespaceRegex: Regex<Substring> = #/\s+/#


    // MARK: - Public API for variables

    /// Generic entry point for variable lines. Returns ["name":..., "type":...].
    static func matchAnyVariableLine(
        _ line: String,
        language: LanguageType,
        stats: CodeMapPerformanceCollector? = nil
    ) -> [String: String]? {
        stats?.lteMatchAnyVariableCalls += 1
        let start = stats == nil ? 0 : CFAbsoluteTimeGetCurrent()
        defer {
            if let stats, start != 0 {
                stats.languageTypeExtractorVariableDuration += (CFAbsoluteTimeGetCurrent() - start)
            }
        }
        switch language {
        case .ts:
            // 1) type alias => "type Name = Something"
            if let m = tsTypeAliasRegex.firstMatch(in: line), let name = capture(m, at: 1) {
                let rhsType = extractTSTypeAliasRHS(from: line) ?? capture(m, at: 2) ?? ""
                return [
                    "name": name,
                    "type": rhsType
                ]
            }
            // 2) class/interface property (no var/let/const)
            if let m = tsClassPropertyRegex.firstMatch(in: line) {
                var result = [String: String]()
                if let name = capture(m, at: 1) {
                    result["name"] = name
                }
                if let typeName = extractTSTypeAnnotation(from: line) {
                    result["type"] = typeName
                }
                return result.isEmpty ? nil : result
            }
            // 2) normal TS var
            if let m = tsVariableRegex.firstMatch(in: line), let name = capture(m, at: 1) {
                var result = ["name": name]
                if let typeName = extractTSTypeAnnotation(from: line) ?? capture(m, at: 2) {
                    result["type"] = typeName.trimmingCharacters(in: .whitespaces)
                }
                return result
            }
            // 3) fallback to jsTs
            if let m = jsTsVariableRegex.firstMatch(in: line), let name = capture(m, at: 1) {
                var result = ["name": name]
                if let typeName = extractTSTypeAnnotation(from: line) ?? capture(m, at: 2) {
                    result["type"] = typeName.trimmingCharacters(in: .whitespaces)
                }
                return result
            }
            return nil

        case .php, .ruby:
            return nil // PHP/Ruby handled purely by AST captures
        case .tsx:
            // same approach for TSX
            if let m = tsTypeAliasRegex.firstMatch(in: line), let name = capture(m, at: 1) {
                let rhsType = extractTSTypeAliasRHS(from: line) ?? capture(m, at: 2) ?? ""
                return [
                    "name": name,
                    "type": rhsType
                ]
            }
            if let m = tsClassPropertyRegex.firstMatch(in: line) {
                var result = [String: String]()
                if let name = capture(m, at: 1) {
                    result["name"] = name
                }
                if let typeName = extractTSTypeAnnotation(from: line) {
                    result["type"] = typeName
                }
                return result.isEmpty ? nil : result
            }
            if let m = tsxVariableRegex.firstMatch(in: line) {
                var result = extractVarMatch(match: m, groupName1: 1, groupName2: 2) ?? [:]
                if let typeName = extractTSTypeAnnotation(from: line) {
                    result["type"] = typeName
                }
                return result.isEmpty ? nil : result
            }
            // fallback
            if let m = jsTsVariableRegex.firstMatch(in: line), let name = capture(m, at: 1) {
                var result = ["name": name]
                if let typeName = extractTSTypeAnnotation(from: line) ?? capture(m, at: 2) {
                    result["type"] = typeName.trimmingCharacters(in: .whitespaces)
                }
                return result
            }
            return nil

        case .swift:
            if let m = swiftVariableRegex.firstMatch(in: line) {
                var result = [String: String]()
                if let name = capture(m, at: 1) {
                    result["name"] = name
                }
                if let type = capture(m, at: 2) {
                    result["type"] = type
                }
                return result.isEmpty ? nil : result
            }
            return nil

        case .c_sharp:
            if let m = line.firstMatch(of: cSharpVariableRegex) {
                var result = [String: String]()
                if let type = capture(m, at: 1) {
                    result["type"] = type
                }
                if let name = capture(m, at: 2) {
                    result["name"] = name
                }
                return result.isEmpty ? nil : result
            }
            return nil

        case .java:
            if let m = line.firstMatch(of: javaVariableRegex) {
                var result = [String: String]()
                if let type = capture(m, at: 1) {
                    result["type"] = type
                }
                if let name = capture(m, at: 2) {
                    result["name"] = name
                }
                return result.isEmpty ? nil : result
            }
            return nil

        case .python:
            if let m = line.firstMatch(of: pythonVariableRegex) {
                // Typed regex: (wholeMatch, varName, typeName)
                return [
                    "name": String(m.1).trimmingCharacters(in: .whitespaces),
                    "type": String(m.2).trimmingCharacters(in: .whitespaces)
                ]
            }
            return nil

        case .js:
            if let m = jsTsVariableRegex.firstMatch(in: line), let name = capture(m, at: 1) {
                var result = ["name": name]
                if let typeName = capture(m, at: 2) {
                    result["type"] = typeName.trimmingCharacters(in: .whitespaces)
                }
                return result
            }
            return nil

        case .go:
            if let m = line.firstMatch(of: goVariableRegex) {
                var result = [String: String]()
                if let name = capture(m, at: 1) {
                    result["name"] = name
                }
                if let type = capture(m, at: 2) {
                    result["type"] = type
                }
                return result.isEmpty ? nil : result
            }
            return nil

        case .rust:
            if let m = line.firstMatch(of: rustVariableRegex) {
                var result = [String: String]()
                if let name = capture(m, at: 1) {
                    result["name"] = name
                }
                if let type = capture(m, at: 2) {
                    result["type"] = type
                }
                return result.isEmpty ? nil : result
            }
            return nil

        case .c:
            if let m = line.firstMatch(of: cVariableRegex) {
                var result = [String: String]()
                if let type = capture(m, at: 1) {
                    result["type"] = type
                }
                if let name = capture(m, at: 2) {
                    result["name"] = name
                }
                return result.isEmpty ? nil : result
            }
            return nil

        case .cpp:
            if let m = line.firstMatch(of: cppVariableRegex) {
                var result = [String: String]()
                if let type = capture(m, at: 1) {
                    result["type"] = type
                }
                if let name = capture(m, at: 2) {
                    result["name"] = name
                }
                return result.isEmpty ? nil : result
            }
            return nil
        }
    }

    // MARK: - Public API for function lines

    struct FunctionLineMatch {
        let name: String?
        let paramList: String?
        let returnType: String?
        let parameterTypes: [String]?

        func asDictionary(language: LanguageType) -> [String: String] {
            var dict: [String: String] = [:]
            if let name, !name.isEmpty { dict["name"] = name }
            if let paramList, !paramList.isEmpty { dict["paramList"] = paramList }
            if let returnType, !returnType.isEmpty { dict["returnType"] = returnType }
            if let parameterTypes, !parameterTypes.isEmpty {
                let joined = parameterTypes.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.joined(separator: ", ")
                dict["parameterTypes"] = joined
            } else if dict["paramList"] != nil {
                dict = dict.thenParseParameters(language: language)
            }
            return dict
        }
    }
    static func matchAnyFunctionLine(
        _ line: String,
        language: LanguageType,
        stats: CodeMapPerformanceCollector? = nil
    ) -> [String: String]? {
        if !(language == .ts || language == .tsx) {
            stats?.lteMatchAnyFunctionCalls += 1
        }
        let shouldMeasure = stats != nil && !(language == .ts || language == .tsx)
        let start = shouldMeasure ? CFAbsoluteTimeGetCurrent() : 0
        defer {
            if let stats, start != 0, shouldMeasure {
                stats.languageTypeExtractorFunctionDuration += (CFAbsoluteTimeGetCurrent() - start)
            }
        }

        switch language {
        // -------------------------------------------------------------------
        // TypeScript
        case .ts:
            if let parsed = matchAnyFunctionLineParsed(line, language: language, stats: stats) {
                return parsed.asDictionary(language: language)
            }
            return nil

        // -------------------------------------------------------------------
        // TSX
        case .tsx:
            if let parsed = matchAnyFunctionLineParsed(line, language: language, stats: stats) {
                return parsed.asDictionary(language: language)
            }
            return nil

        // -------------------------------------------------------------------
        // Swift
        case .swift:
            if let m = swiftFunctionRegex.firstMatch(in: line) {
                var result = [String: String]()
                if let val = capture(m, at: 1) {
                    result["name"] = val
                }
                if let val = capture(m, at: 2) {
                    result["paramList"] = val
                }
                if let val = capture(m, at: 3) {
                    result["returnType"] = val
                }
                return result.thenParseParameters(language: language)
            }
            return nil

        case .c_sharp:
            if let m = line.firstMatch(of: cSharpFunctionRegex) {
                let extracted = extractNamedGroups(
                    match: m,
                    groupNames: ("returnType", "name", "paramList"),
                    indices: (1, 2, 3)
                )
                return extracted.thenParseParameters(language: language)
            }
            return nil

        case .java:
            if let m = line.firstMatch(of: javaFunctionRegex) {
                let extracted = extractNamedGroups(
                    match: m,
                    groupNames: ("returnType", "name", "paramList"),
                    indices: (1, 2, 3)
                )
                return extracted.thenParseParameters(language: language)
            }
            return nil

        case .python:
            if let m = line.firstMatch(of: pythonFunctionRegex) {
                // Typed regex: (wholeMatch, funcName, paramList, returnType?)
                var result = [String: String]()
                result["name"] = String(m.1).trimmingCharacters(in: .whitespaces)
                result["paramList"] = String(m.2).trimmingCharacters(in: .whitespaces)
                if let returnType = m.3 {
                    result["returnType"] = String(returnType).trimmingCharacters(in: .whitespaces)
                }
                return result.thenParseParameters(language: language)
            }
            return nil

        case .js:
            if let m = jsTsFunctionRegex.firstMatch(in: line), let name = capture(m, at: 1), let paramList = capture(m, at: 2) {
                var result = [
                    "name": name,
                    "paramList": paramList
                ]
                if let returnType = capture(m, at: 3) {
                    result["returnType"] = returnType
                }
                return result.thenParseParameters(language: language)
            }
            if let m = tsArrowFunctionRegex.firstMatch(in: line) {
                var arrowResult = [String: String]()
                if let val = capture(m, at: 1) {
                    arrowResult["name"] = val
                }
                if let val = capture(m, at: 2) {
                    arrowResult["returnType"] = val
                }
                return arrowResult
            }
            return nil

        case .go:
            if let m = line.firstMatch(of: goFunctionRegex) {
                var dict = extractNamedGroups(
                    match: m,
                    groupNames: ("name", "paramList", "returnBlock"),
                    indices: (1, 2, 3)
                )

                // Instead of the default parseCStyleParameterList(...) call, do parseGoParameterList:
                if let paramList = dict["paramList"] {
                    let paramTypes = parseGoParameterList(paramList)
                    dict["parameterTypes"] = paramTypes.joined(separator: ", ")
                }
                // tidy up return type if needed, etc.
                return dict
            }
            return nil

        case .rust:
            if let m = line.firstMatch(of: rustFunctionRegex) {
                var result = [String: String]()
                if let val = capture(m, at: 1) {
                    result["name"] = val
                }
                if let val = capture(m, at: 2) {
                    result["paramList"] = val
                }
                // optional trailing return
                if let val = capture(m, at: 3) {
                    result["returnType"] = val
                }
                return result.thenParseParameters(language: language)
            }
            return nil

        case .c:
            if let m = line.firstMatch(of: cFunctionRegex) {
                let extracted = extractNamedGroups(
                    match: m,
                    groupNames: ("returnType", "name", "paramList"),
                    indices: (1, 2, 3)
                )
                return extracted.thenParseParameters(language: language)
            }
            return nil

        case .cpp:
            // constructor (no return type)
            if let m = line.firstMatch(of: cppConstructorRegex) {
                var result = [String: String]()
                if let val = capture(m, at: 1) {
                    result["name"] = val.split(separator: "::").last.map(String.init) ?? val
                }
                if let val = capture(m, at: 2) {
                    result["paramList"] = val
                }
                return result.thenParseParameters(language: language)
            }
            // normal function
            if let m = line.firstMatch(of: cppFunctionRegex) {
                let extracted = extractNamedGroups(
                    match: m,
                    groupNames: ("returnType", "name", "paramList"),
                    indices: (1, 2, 3)
                )
                return extracted.thenParseParameters(language: language)
            }
            // trailing-return
            if let m = line.firstMatch(of: cppTrailingReturnFunctionRegex) {
                var result = [String: String]()
                if let val = capture(m, at: 1) {
                    result["name"] = val
                }
                if let val = capture(m, at: 2) {
                    result["paramList"] = val
                }
                if let val = capture(m, at: 3) {
                    result["returnType"] = val
                }
                return result.thenParseParameters(language: language)
            }
            return nil

        case .php, .ruby:
            // PHP/Ruby function extraction is handled by AST captures, not regex
            return nil
        }
    }

    fileprivate static func parseGoParameterList(_ paramList: String) -> [String] {
        // "func foo(a, b int, s string)" => paramList == "a, b int, s string"
        //  => after splitting by commas => ["a, b int", "s string"]

        let chunks = paramList
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }

        var results = [String]()
        var pendingNames = [String]()

        for chunk in chunks {
            // chunk might look like "a, b int" or "id string" or "version int"
            // 1) remove any "=defaultValue" (Go usually doesn't do defaults, but let's be safe)
            let noDefault = chunk.split(separator: "=").first?.trimmingCharacters(in: .whitespaces) ?? chunk

            // 2) split the remainder by whitespace => tokens
            //    e.g. "a, b int" -> ["a,", "b", "int"]
            var tokens = noDefault
                .split(whereSeparator: \.isWhitespace)
                .map { String($0).trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }

            if tokens.count >= 2 {
                let last = tokens.removeLast()
                let goType = stripTrailingCommasAndParens(last)

                let nameTokens = pendingNames + tokens.map { stripTrailingCommasAndParens($0) }
                for _ in nameTokens where !goType.isEmpty {
                    results.append(goType)
                }
                pendingNames.removeAll()
                continue
            }

            guard let only = tokens.first else {
                results.append("untyped")
                continue
            }

            let token = stripTrailingCommasAndParens(only)
            let looksLikeType = token.contains(".")
                || token.contains("*")
                || token.contains("[")
                || token.hasPrefix("map[")
                || token.hasPrefix("chan")
                || token.hasPrefix("func")
                || token.hasPrefix("...")

            if looksLikeType, pendingNames.isEmpty {
                results.append(token.isEmpty ? "untyped" : token)
            } else {
                pendingNames.append(token)
            }
        }

        if !pendingNames.isEmpty {
            results.append(contentsOf: pendingNames.map { _ in "untyped" })
        }

        return results
    }

    fileprivate static func stripTrailingCommasAndParens(_ s: String) -> String {
        var out = s
        // remove possible trailing punctuation like commas, parentheses
        while let lastChar = out.last, [",", "(", ")", ":"].contains(lastChar) {
            out.removeLast()
        }
        return out.trimmingCharacters(in: .whitespaces)
    }

    // MARK: - Shared / Private Helpers (Swift Regex)

    /// Typealias for Swift Regex match result with dynamic output.
    typealias RegexMatch = Regex<AnyRegexOutput>.Match

    /// Extracts variable name and type from a regex match.
    /// - Parameters:
    ///   - match: The regex match result
    ///   - groupName1: Index of the capture group for "name"
    ///   - groupName2: Index of the capture group for "type"
    private static func extractVarMatch(
        match: RegexMatch,
        groupName1: Int,
        groupName2: Int
    ) -> [String: String]? {
        var result = [String: String]()
        if let capture1 = match.output[groupName1].substring {
            result["name"] = String(capture1).trimmingCharacters(in: .whitespaces)
        }
        if let capture2 = match.output[groupName2].substring {
            result["type"] = String(capture2).trimmingCharacters(in: .whitespaces)
        }
        return result.isEmpty ? nil : result
    }

    private static func extractVarMatch(
        match: CodeMapPCRE2Match,
        groupName1: Int,
        groupName2: Int
    ) -> [String: String]? {
        var result = [String: String]()
        if let capture1 = capture(match, at: groupName1) {
            result["name"] = capture1
        }
        if let capture2 = capture(match, at: groupName2) {
            result["type"] = capture2
        }
        return result.isEmpty ? nil : result
    }

    /// Checks if a capture group at the given index has a value.
    private static func matchHasGroup(_ match: RegexMatch, _ groupIndex: Int) -> Bool {
        groupIndex < match.output.count && match.output[groupIndex].substring != nil
    }

    /// Gets the captured substring at the given index, or nil if not captured.
    static func capture(_ match: RegexMatch, at index: Int) -> String? {
        guard index < match.output.count,
              let substring = match.output[index].substring else { return nil }
        return String(substring).trimmingCharacters(in: .whitespaces)
    }

    /// Gets the captured substring at the given index from a PCRE2 match.
    static func capture(_ match: CodeMapPCRE2Match, at index: Int) -> String? {
        match.trimmedCapture(index)
    }

    /// Extracts up to 3 named groups from a match, returning them in a dict.
    static func extractNamedGroups(
        match: RegexMatch,
        groupNames: (String, String, String),
        indices: (Int, Int, Int)
    ) -> [String: String] {
        var dict = [String: String]()
        let (g1Name, g2Name, g3Name) = groupNames
        let (i1, i2, i3) = indices

        if let val1 = capture(match, at: i1) {
            dict[g1Name] = val1
        }
        if let val2 = capture(match, at: i2) {
            dict[g2Name] = val2
        }
        if let val3 = capture(match, at: i3) {
            dict[g3Name] = val3
        }
        return dict
    }

    static func extractNamedGroups(
        match: CodeMapPCRE2Match,
        groupNames: (String, String, String),
        indices: (Int, Int, Int)
    ) -> [String: String] {
        var dict = [String: String]()
        let (g1Name, g2Name, g3Name) = groupNames
        let (i1, i2, i3) = indices

        if let val1 = capture(match, at: i1) {
            dict[g1Name] = val1
        }
        if let val2 = capture(match, at: i2) {
            dict[g2Name] = val2
        }
        if let val3 = capture(match, at: i3) {
            dict[g3Name] = val3
        }
        return dict
    }

    fileprivate static func parseCStyleParameterList(_ paramList: String) -> [String] {
        let chunks = paramList.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        var results = [String]()

        for chunk in chunks {
            if chunk.isEmpty { continue }
            // skip varargs
            if chunk.contains("...") {
                results.append("varargs")
                continue
            }
            // remove everything after '=' (default args)
            let maybeNoDefault = chunk.split(separator: "=").first?.trimmingCharacters(in: .whitespaces) ?? chunk
            // remove decorators (out|ref|etc.)
            let cleaned = maybeNoDefault.replacing(cStyleDecoratorRegex, with: "")
                .trimmingCharacters(in: .whitespaces)

            // Attempt to separate type from name by the last space
            if let match = cleaned.firstMatch(of: lastWordSeparatorRegex) {
                let typePart = cleaned[..<match.range.lowerBound].trimmingCharacters(in: .whitespaces)
                if !typePart.isEmpty {
                    results.append(typePart)
                } else {
                    results.append(cleaned)
                }
            } else {
                results.append(cleaned)
            }
        }
        return results.filter { !$0.isEmpty }
    }

    static func parseTSParameterList(_ paramList: String) -> [String] {
        let chunks = TopLevelScanner
            .splitTopLevel(paramList, separator: ",", track: .all)
            .map { paramList[$0].trimmingCharacters(in: .whitespaces) }
        var results = [String]()

        for chunk in chunks {
            if chunk.isEmpty { continue }
            var cleanChunk = chunk

            // Remove possible modifiers
            let modifiers = ["private", "public", "protected", "readonly", "abstract", "override"]
            var foundModifier = true
            while foundModifier {
                foundModifier = false
                for mod in modifiers {
                    if cleanChunk.hasPrefix("\(mod) ") {
                        cleanChunk = cleanChunk.dropFirst(mod.count + 1).trimmingCharacters(in: .whitespaces)
                        foundModifier = true
                        break
                    }
                }
            }

            // remove default
            let noDefault = cleanChunk.split(separator: "=").first?.trimmingCharacters(in: .whitespaces) ?? cleanChunk

            // if there's a colon => that's the type
            if let colonIdx = TopLevelScanner.firstTopLevelIndex(of: ":", in: noDefault, track: .all) {
                if let questionIdx = TopLevelScanner.firstTopLevelIndex(of: "?", in: noDefault, track: .all),
                   questionIdx < colonIdx,
                   noDefault.index(after: questionIdx) != colonIdx
                {
                    // Conditional type - keep as-is
                    results.append(noDefault.trimmingCharacters(in: .whitespaces))
                } else {
                    let typePart = noDefault[noDefault.index(after: colonIdx)...]
                        .trimmingCharacters(in: .whitespaces)
                    results.append(typePart.isEmpty ? "any" : typePart)
                }
            } else {
                results.append("any")
            }
        }

        return results
    }

    fileprivate static func splitTopLevelTokens(_ text: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        var parenDepth = 0
        var bracketDepth = 0
        var braceDepth = 0
        var angleDepth = 0
        var inString: Character? = nil
        var escaped = false

        for ch in text {
            if let stringDelimiter = inString {
                current.append(ch)
                if escaped {
                    escaped = false
                } else if ch == "\\" {
                    escaped = true
                } else if ch == stringDelimiter {
                    inString = nil
                }
                continue
            }

            if ch == "\"" || ch == "'" {
                inString = ch
                current.append(ch)
                continue
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
                braceDepth += 1
            case "}":
                braceDepth = max(0, braceDepth - 1)
            case "<":
                angleDepth += 1
            case ">":
                angleDepth = max(0, angleDepth - 1)
            default:
                break
            }

            if ch.isWhitespace, parenDepth == 0, bracketDepth == 0, braceDepth == 0, angleDepth == 0 {
                if !current.isEmpty {
                    tokens.append(current)
                    current = ""
                }
                continue
            }

            current.append(ch)
        }

        if !current.isEmpty {
            tokens.append(current)
        }

        return tokens.filter { !$0.isEmpty }
    }

    fileprivate static func extractSwiftParameterTypes(_ paramList: String) -> [String] {
        let params = paramList.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        var types: [String] = []

        for p in params {
            let noDefault = p.split(separator: "=").first?.trimmingCharacters(in: .whitespaces) ?? p
            let cleaned = noDefault.replacing(swiftDecoratorRegex, with: "")
                .trimmingCharacters(in: .whitespaces)

            if let colonIndex = cleaned.firstIndex(of: ":") {
                let afterColon = cleaned[cleaned.index(after: colonIndex)...].trimmingCharacters(in: .whitespaces)
                if let eqIndex = afterColon.firstIndex(of: "=") {
                    let rawType = afterColon[..<eqIndex].trimmingCharacters(in: .whitespaces)
                    types.append(String(rawType))
                } else {
                    types.append(String(afterColon))
                }
            } else {
                types.append("untyped")
            }
        }
        return types
    }

    fileprivate static func parsePythonParameterList(_ paramList: String) -> [String] {
        let chunks = paramList.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        var results = [String]()

        for chunk in chunks {
            // varargs or kwargs
            if chunk.hasPrefix("*") || chunk.hasPrefix("**") {
                results.append("untyped")
                continue
            }
            let noDefault = chunk.split(separator: "=").first?.trimmingCharacters(in: .whitespaces) ?? chunk
            if let colonIndex = noDefault.firstIndex(of: ":") {
                let afterColon = noDefault[noDefault.index(after: colonIndex)...].trimmingCharacters(in: .whitespaces)
                results.append(String(afterColon))
            } else {
                results.append("untyped")
            }
        }
        return results
    }

    fileprivate static func parseRustParameterList(_ paramList: String) -> [String] {
        let chunks = paramList.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        var results = [String]()

        for chunk in chunks {
            let noDefault = chunk.split(separator: "=").first?.trimmingCharacters(in: .whitespaces) ?? chunk
            let normalizedRaw = noDefault.replacing(multiWhitespaceRegex, with: " ")
                .trimmingCharacters(in: .whitespaces)
            if normalizedRaw == "self"
                || normalizedRaw == "&self"
                || normalizedRaw == "&mut self"
                || normalizedRaw == "mut self"
            {
                continue
            }

            let stripped = noDefault.replacing(rustDecoratorRegex, with: "")
                .trimmingCharacters(in: .whitespaces)

            if let colonIndex = stripped.firstIndex(of: ":") {
                let afterColon = stripped[stripped.index(after: colonIndex)...].trimmingCharacters(in: .whitespaces)
                results.append(String(afterColon))
            } else {
                results.append("untyped")
            }
        }
        return results
    }
}
private extension [String: String] {
    /// After capturing ["name","paramList","returnType"], parse the paramList
    /// for each language and store the result in "parameterTypes".
    /// Also does final trimming on "returnType".
    func thenParseParameters(language: LanguageType) -> [String: String] {
        var result = self

        if let paramList = self["paramList"] {
            let trimmedList = paramList.trimmingCharacters(in: .whitespacesAndNewlines)
            switch language {
            case .python:
                let paramTypes = LanguageTypeExtractor.parsePythonParameterList(trimmedList)
                result["parameterTypes"] = paramTypes.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: ", ")
            case .rust:
                let paramTypes = LanguageTypeExtractor.parseRustParameterList(trimmedList)
                result["parameterTypes"] = paramTypes.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: ", ")
            case .swift:
                let paramTypes = LanguageTypeExtractor.extractSwiftParameterTypes(trimmedList)
                result["parameterTypes"] = paramTypes.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: ", ")
            case .ts, .tsx:
                let paramTypes = LanguageTypeExtractor.parseTSParameterList(trimmedList)
                result["parameterTypes"] = paramTypes.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: ", ")
            default:
                let paramTypes = LanguageTypeExtractor.parseCStyleParameterList(trimmedList)
                result["parameterTypes"] = paramTypes.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: ", ")
            }
        }

        // Trim "returnType" if present
        if let ret = result["returnType"] {
            result["returnType"] = ret.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return result
    }
}
