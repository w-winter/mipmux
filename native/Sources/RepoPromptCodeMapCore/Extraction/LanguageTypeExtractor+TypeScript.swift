// Modified for smip: declarations relocated and cross-file access adjusted.
import Foundation
import CoreFoundation

extension LanguageTypeExtractor {
    private static func normalizeWhitespaceRun(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        var previousWasWhitespace = true
        for ch in text {
            if ch.isWhitespace {
                if !previousWasWhitespace {
                    out.append(" ")
                    previousWasWhitespace = true
                }
            } else {
                out.append(ch)
                previousWasWhitespace = false
            }
        }
        if out.last == " " {
            out.removeLast()
        }
        return out
    }

    private enum TSLineKind {
        case constructor
        case accessor
        case functionKeyword
        case arrowAssigned
        case arrowFunction
        case methodLike
        case unknown
    }

    private static func firstTopLevelIndex(
        of char: Character,
        in text: String,
        startingAt start: String.Index? = nil
    ) -> String.Index? {
        var angleDepth = 0
        var parenDepth = 0
        var braceDepth = 0
        var bracketDepth = 0
        var i = start ?? text.startIndex
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
            default: break
            }
            if angleDepth == 0, parenDepth == 0, braceDepth == 0, bracketDepth == 0, ch == char {
                return i
            }
            i = text.index(after: i)
        }
        return nil
    }

    private static func firstTopLevelIndex(
        ofAny chars: Set<Character>,
        in text: String,
        startingAt start: String.Index? = nil
    ) -> String.Index? {
        var angleDepth = 0
        var parenDepth = 0
        var braceDepth = 0
        var bracketDepth = 0
        var i = start ?? text.startIndex
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
            default: break
            }
            if angleDepth == 0, parenDepth == 0, braceDepth == 0, bracketDepth == 0, chars.contains(ch) {
                return i
            }
            i = text.index(after: i)
        }
        return nil
    }

    private static func firstTopLevelAssignmentEquals(
        in text: String,
        startingAt start: String.Index? = nil
    ) -> String.Index? {
        var angleDepth = 0
        var parenDepth = 0
        var braceDepth = 0
        var bracketDepth = 0
        var i = start ?? text.startIndex
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

    private static func findTopLevelSubstring(
        _ needle: String,
        in text: String,
        startingAt start: String.Index? = nil
    ) -> String.Index? {
        guard !needle.isEmpty else { return nil }
        let needleChars = Array(needle)
        var angleDepth = 0
        var parenDepth = 0
        var braceDepth = 0
        var bracketDepth = 0
        var i = start ?? text.startIndex
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
            default: break
            }
            if angleDepth == 0, parenDepth == 0, braceDepth == 0, bracketDepth == 0 {
                if ch == needleChars.first,
                   let endIndex = text.index(i, offsetBy: needleChars.count, limitedBy: text.endIndex)
                {
                    let candidate = text[i ..< endIndex]
                    if candidate.elementsEqual(needleChars) {
                        return i
                    }
                }
            }
            i = text.index(after: i)
        }
        return nil
    }

    private static func findMatchingParen(in text: String, startIndex: String.Index) -> String.Index? {
        var depth = 0
        var i = startIndex
        while i < text.endIndex {
            let ch = text[i]
            if ch == "(" { depth += 1 }
            if ch == ")" {
                depth -= 1
                if depth == 0 { return i }
            }
            i = text.index(after: i)
        }
        return nil
    }

    private static func findMatchingBrace(in text: String, startIndex: String.Index) -> String.Index? {
        var depth = 0
        var i = startIndex
        while i < text.endIndex {
            let ch = text[i]
            if ch == "{" { depth += 1 }
            if ch == "}" {
                depth -= 1
                if depth == 0 { return i }
            }
            i = text.index(after: i)
        }
        return nil
    }

    private static func trimTSType(_ typeText: Substring) -> String? {
        var cleaned = String(typeText).trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("{"),
           let endIndex = findMatchingBrace(in: cleaned, startIndex: cleaned.startIndex)
        {
            cleaned = String(cleaned[...endIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if !cleaned.hasPrefix("{"),
           let braceIndex = firstTopLevelIndex(of: "{", in: cleaned)
        {
            let beforeBrace = String(cleaned[..<braceIndex])
            if firstTopLevelIndex(ofAny: ["&", "|"], in: beforeBrace) == nil {
                cleaned = beforeBrace.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        if let endIndex = firstTopLevelIndex(of: ";", in: cleaned) {
            cleaned = String(cleaned[..<endIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        while let last = cleaned.last, last == "&" || last == "|" {
            cleaned.removeLast()
            cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return cleaned.isEmpty ? nil : cleaned
    }

    private static func normalizeTSLine(_ line: String) -> String {
        normalizeWhitespaceRun(line)
    }

    static func extractTSReturnType(from signature: String, stats: CodeMapPerformanceCollector? = nil) -> String? {
        let trimmed = normalizeTSLine(signature)
        guard !trimmed.isEmpty else { return nil }
        let hasFunctionKeyword = trimmed.range(of: #"\bfunction\b"#, options: .regularExpression) != nil
        let arrowRange = hasFunctionKeyword ? nil : TopLevelScanner.firstTopLevelRange(of: "=>", in: trimmed, track: .all)
        let endIndex = arrowRange?.lowerBound ?? trimmed.endIndex

        if let openParen = firstTopLevelIndex(of: "(", in: trimmed),
           let closeParen = findMatchingParen(in: trimmed, startIndex: openParen)
        {
            let searchStart = trimmed.index(after: closeParen)
            if let colon = firstTopLevelIndex(of: ":", in: trimmed, startingAt: searchStart),
               colon < endIndex
            {
                let typeStart = trimmed.index(after: colon)
                let result = trimTSType(trimmed[typeStart ..< endIndex])
                if result != nil {
                    stats?.tsReturnTypeFastPathHits += 1
                }
                return result
            }
        }

        if let colon = firstTopLevelIndex(of: ":", in: trimmed),
           colon < endIndex
        {
            let typeStart = trimmed.index(after: colon)
            let result = trimTSType(trimmed[typeStart ..< endIndex])
            if result != nil {
                stats?.tsReturnTypeFastPathHits += 1
            }
            return result
        }
        return nil
    }

    static func extractTSTypeAnnotation(from line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let colon = firstTopLevelIndex(of: ":", in: trimmed) else { return nil }
        let typeStart = trimmed.index(after: colon)
        let eqIndex = firstTopLevelAssignmentEquals(in: trimmed, startingAt: typeStart)
        let semiIndex = firstTopLevelIndex(of: ";", in: trimmed, startingAt: typeStart)
        var endIndex = trimmed.endIndex
        if let eqIndex, eqIndex < endIndex { endIndex = eqIndex }
        if let semiIndex, semiIndex < endIndex { endIndex = semiIndex }
        return trimTSType(trimmed[typeStart ..< endIndex])
    }

    static func extractTSTypeAliasRHS(from line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let eqIndex = firstTopLevelIndex(of: "=", in: trimmed) else { return nil }
        let typeStart = trimmed.index(after: eqIndex)
        let endIndex = firstTopLevelIndex(ofAny: [";"], in: trimmed, startingAt: typeStart) ?? trimmed.endIndex
        return trimTSType(trimmed[typeStart ..< endIndex])
    }

    private static func stripTSLeadingModifiers(_ line: String) -> String {
        var trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let modifiers = [
            "export", "default", "public", "private", "protected",
            "static", "readonly", "abstract", "async", "override"
        ]
        var foundModifier = true
        while foundModifier {
            foundModifier = false
            for mod in modifiers {
                if trimmed.hasPrefix("\(mod) ") {
                    trimmed = trimmed.dropFirst(mod.count + 1).trimmingCharacters(in: .whitespacesAndNewlines)
                    foundModifier = true
                    break
                }
            }
        }
        return trimmed
    }

    private static func classifyTSFunctionLine(_ line: String) -> TSLineKind {
        let trimmed = stripTSLeadingModifiers(line)
        if trimmed.hasPrefix("constructor") {
            return .constructor
        }
        if trimmed.hasPrefix("get ") || trimmed.hasPrefix("set ") {
            return .accessor
        }
        if trimmed.hasPrefix("function") || trimmed.contains("function ") {
            return .functionKeyword
        }
        if trimmed.contains("=>") {
            if trimmed.contains("=") {
                return .arrowAssigned
            }
            return .arrowFunction
        }
        if trimmed.isEmpty {
            return .unknown
        }
        return .methodLike
    }

    /// Generic entry point for function lines. Returns a dictionary with keys
    /// ["name":..., "returnType":..., "paramList":..., "parameterTypes":...].
    static func matchAnyFunctionLineParsed(
        _ line: String,
        language: LanguageType,
        stats: CodeMapPerformanceCollector? = nil
    ) -> FunctionLineMatch? {
        stats?.lteMatchAnyFunctionCalls += 1
        let start = stats == nil ? 0 : CFAbsoluteTimeGetCurrent()
        defer {
            if let stats, start != 0 {
                stats.languageTypeExtractorFunctionDuration += (CFAbsoluteTimeGetCurrent() - start)
            }
        }
        switch language {
        case .ts, .tsx:
            let kind = classifyTSFunctionLine(line)
            let isTSX = (language == .tsx)
            let parsedReturnType = extractTSReturnType(from: line, stats: stats)

            switch kind {
            case .constructor:
                if let m = tsConstructorRegex.firstMatch(in: line) {
                    if isTSX {
                        stats?.tsxConstructorMatches += 1
                    } else {
                        stats?.tsConstructorMatches += 1
                    }
                    let paramList = capture(m, at: 1)
                    let paramTypes = paramList.map { LanguageTypeExtractor.parseTSParameterList($0) }
                    return FunctionLineMatch(
                        name: "constructor",
                        paramList: paramList,
                        returnType: nil,
                        parameterTypes: paramTypes
                    )
                }
                return nil

            case .accessor:
                if let m = tsAccessorRegex.firstMatch(in: line) {
                    if isTSX {
                        stats?.tsxAccessorMatches += 1
                    } else {
                        stats?.tsAccessorMatches += 1
                    }
                    let prefix = capture(m, at: 1)
                    let name = capture(m, at: 2)
                    let paramList = capture(m, at: 3)
                    let returnType = parsedReturnType ?? capture(m, at: 4)
                    let paramTypes = paramList.map { LanguageTypeExtractor.parseTSParameterList($0) }
                    let fullName = [prefix, name].compactMap(\.self).joined(separator: " ")
                    return FunctionLineMatch(
                        name: fullName.isEmpty ? nil : fullName,
                        paramList: paramList,
                        returnType: returnType,
                        parameterTypes: paramTypes
                    )
                }
                return nil

            case .functionKeyword:
                if isTSX, let m = tsxFunctionRegex.firstMatch(in: line) {
                    stats?.tsxClassMethodMatches += 1
                    let name = capture(m, at: 1)
                    let paramList = capture(m, at: 2)
                    let returnType = parsedReturnType ?? capture(m, at: 3)
                    let paramTypes = paramList.map { LanguageTypeExtractor.parseTSParameterList($0) }
                    return FunctionLineMatch(
                        name: name,
                        paramList: paramList,
                        returnType: returnType,
                        parameterTypes: paramTypes
                    )
                }
                if let m = jsTsFunctionRegex.firstMatch(in: line), let name = capture(m, at: 1), let paramList = capture(m, at: 2) {
                    if isTSX {
                        stats?.tsxClassMethodMatches += 1
                    } else {
                        stats?.tsClassMethodMatches += 1
                    }
                    let returnType = parsedReturnType ?? capture(m, at: 3)
                    let paramTypes = LanguageTypeExtractor.parseTSParameterList(paramList)
                    return FunctionLineMatch(
                        name: name,
                        paramList: paramList,
                        returnType: returnType,
                        parameterTypes: paramTypes
                    )
                }
                return nil

            case .arrowAssigned:
                if let m = tsClassArrowMethodRegex.firstMatch(in: line) {
                    if isTSX {
                        stats?.tsxClassArrowMatches += 1
                    } else {
                        stats?.tsClassArrowMatches += 1
                    }
                    let name = capture(m, at: 1)
                    let paramList = capture(m, at: 2)
                    let returnType = parsedReturnType ?? capture(m, at: 3)
                    let paramTypes = paramList.map { LanguageTypeExtractor.parseTSParameterList($0) }
                    return FunctionLineMatch(
                        name: name,
                        paramList: paramList,
                        returnType: returnType,
                        parameterTypes: paramTypes
                    )
                }
                if let m = tsClassArrowNoParensRegex.firstMatch(in: line) {
                    if isTSX {
                        stats?.tsxClassArrowNoParensMatches += 1
                    } else {
                        stats?.tsClassArrowNoParensMatches += 1
                    }
                    let name = capture(m, at: 1)
                    let paramName = capture(m, at: 2)
                    let paramType = capture(m, at: 3)
                    let paramList = (paramName != nil && paramType != nil) ? "\(paramName!): \(paramType!)" : nil
                    return FunctionLineMatch(
                        name: name,
                        paramList: paramList,
                        returnType: parsedReturnType,
                        parameterTypes: paramType.map { [$0] }
                    )
                }
                fallthrough

            case .arrowFunction:
                if isTSX, let m = tsxArrowFunctionRegex.firstMatch(in: line) {
                    stats?.tsxArrowFunctionMatches += 1
                    let name = capture(m, at: 1)
                    let returnType = parsedReturnType ?? capture(m, at: 2)
                    return FunctionLineMatch(
                        name: name,
                        paramList: nil,
                        returnType: returnType,
                        parameterTypes: nil
                    )
                }
                if let m = tsArrowFunctionRegex.firstMatch(in: line) {
                    if isTSX {
                        stats?.tsxArrowFunctionMatches += 1
                    } else {
                        stats?.tsArrowFunctionMatches += 1
                    }
                    let name = capture(m, at: 1)
                    let returnType = parsedReturnType ?? capture(m, at: 2)
                    return FunctionLineMatch(
                        name: name,
                        paramList: nil,
                        returnType: returnType,
                        parameterTypes: nil
                    )
                }
                if let m2 = tsArrowFunctionParamsReturnRegex.firstMatch(in: line), let name = capture(m2, at: 1), let paramList = capture(m2, at: 2) {
                    if isTSX {
                        stats?.tsxArrowFunctionParamsReturnMatches += 1
                    } else {
                        stats?.tsArrowFunctionParamsReturnMatches += 1
                    }
                    let returnType = parsedReturnType ?? capture(m2, at: 3)
                    let paramTypes = LanguageTypeExtractor.parseTSParameterList(paramList)
                    return FunctionLineMatch(
                        name: name,
                        paramList: paramList,
                        returnType: returnType,
                        parameterTypes: paramTypes
                    )
                }
                return nil

            case .methodLike:
                if let m = tsClassMethodRegex.firstMatch(in: line) {
                    if isTSX {
                        stats?.tsxClassMethodMatches += 1
                    } else {
                        stats?.tsClassMethodMatches += 1
                    }
                    let dict = extractNamedGroups(
                        match: m,
                        groupNames: ("name", "paramList", "returnType"),
                        indices: (1, 2, 3)
                    )
                    let name = dict["name"]
                    let paramList = dict["paramList"]
                    let returnType = parsedReturnType ?? dict["returnType"]
                    let paramTypes = paramList.map { LanguageTypeExtractor.parseTSParameterList($0) }
                    return FunctionLineMatch(
                        name: name,
                        paramList: paramList,
                        returnType: returnType,
                        parameterTypes: paramTypes
                    )
                }
                return nil

            case .unknown:
                return nil
            }

        default:
            return nil
        }
    }

}
extension LanguageTypeExtractor {
    enum TS {
        static func extractTypeAnnotation(from line: String) -> String? {
            LanguageTypeExtractor.extractTSTypeAnnotation(from: line)
        }

        static func extractTypeAliasRHS(from line: String) -> String? {
            LanguageTypeExtractor.extractTSTypeAliasRHS(from: line)
        }

        static func extractReturnType(from signature: String, stats: CodeMapPerformanceCollector? = nil) -> String? {
            LanguageTypeExtractor.extractTSReturnType(from: signature, stats: stats)
        }

        static func parseParameterTypes(from paramList: String) -> [String] {
            LanguageTypeExtractor.parseTSParameterList(paramList)
        }
    }
}

