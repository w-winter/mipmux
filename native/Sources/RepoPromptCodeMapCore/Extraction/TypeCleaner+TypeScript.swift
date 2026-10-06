// Modified for smip: declarations relocated and cross-file access adjusted.
import Foundation
import CoreFoundation

extension TypeCleaner {
    // MARK: - TypeScript/TSX

    static func extractBaseTypesTS(_ rawType: String, language: LanguageType) -> [String] {
        var trimmed = rawType.trimmingCharacters(in: .whitespacesAndNewlines)
        trimmed = removeComments(from: trimmed, language: language)
        trimmed = removeMethodCalls(trimmed)
        trimmed = stripUnmatchedAngleBrackets(trimmed)
        if trimmed.hasSuffix("?") {
            trimmed.removeLast()
        }

        // Remove TS type operators like 'keyof' and 'typeof'
        trimmed = regexReplace(RegexCache.tsKeyof, in: trimmed)
        trimmed = regexReplace(RegexCache.tsTypeof, in: trimmed)
        trimmed = regexReplace(RegexCache.tsReadonly, in: trimmed)

        // Handle TS function types at top level: (A, B) => C
        if let arrowIndex = findTopLevelString(in: trimmed, needle: "=>") {
            let paramPart = String(trimmed[..<arrowIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
            let returnPart = String(trimmed[trimmed.index(arrowIndex, offsetBy: 2)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let paramInner = stripSurroundingParenPairs(paramPart)
            let paramChunks = splitByTopLevelCommas(paramInner)
            var extracted: [String] = []
            for chunk in paramChunks {
                let normalized = stripTSParamLabelAndDefault(chunk)
                if !normalized.isEmpty {
                    extracted.append(contentsOf: extractBaseTypesTS(normalized, language: language))
                }
            }
            if !returnPart.isEmpty {
                extracted.append(contentsOf: extractBaseTypesTS(returnPart, language: language))
            }
            let filtered = filterOutPrimitiveAndSpecialTypes(extracted, language: language)
            return Array(Set(filtered))
        }

        // Handle TS object literal types: { a: T; b: U }
        if trimmed.hasPrefix("{") {
            let extracted = extractTSObjectLiteralTypes(from: trimmed, language: language)
            let filtered = filterOutPrimitiveAndSpecialTypes(extracted, language: language)
            return Array(Set(filtered))
        }

        // Split top-level '|' or '&'
        let splitted = splitTSUnionsAndIntersections(trimmed)

        var finalTypes = [String]()
        for piece in splitted {
            let trimmedPiece = piece.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedPiece.hasPrefix("{") {
                let extracted = extractTSObjectLiteralTypes(from: trimmedPiece, language: language)
                finalTypes.append(contentsOf: extracted)
            } else {
                let subTypes = extractBaseTypesNonTS(trimmedPiece, language: language)
                finalTypes.append(contentsOf: subTypes)
            }
        }

        let filtered = filterOutPrimitiveAndSpecialTypes(finalTypes, language: language)
        return Array(Set(filtered))
    }

    static func extractBaseTypesTSCached(
        _ rawType: String,
        language: LanguageType,
        cache: inout [TypeCleanerCacheKey: [String]],
        stats: CodeMapPerformanceCollector?
    ) -> [String] {
        let precleanStart = stats == nil ? 0 : CFAbsoluteTimeGetCurrent()
        var trimmed = rawType.trimmingCharacters(in: .whitespacesAndNewlines)
        trimmed = removeComments(from: trimmed, language: language)
        trimmed = removeMethodCalls(trimmed)
        trimmed = stripUnmatchedAngleBrackets(trimmed)
        if trimmed.hasSuffix("?") {
            trimmed.removeLast()
        }

        // Remove TS type operators like 'keyof' and 'typeof'
        trimmed = regexReplace(RegexCache.tsKeyof, in: trimmed)
        trimmed = regexReplace(RegexCache.tsTypeof, in: trimmed)
        trimmed = regexReplace(RegexCache.tsReadonly, in: trimmed)
        if let stats {
            recordTypeCleanerPhase(.preclean, duration: CFAbsoluteTimeGetCurrent() - precleanStart, stats: stats)
        }

        let logicStart = stats == nil ? 0 : CFAbsoluteTimeGetCurrent()
        defer {
            if let stats {
                recordTypeCleanerPhase(.tsLogic, duration: CFAbsoluteTimeGetCurrent() - logicStart, stats: stats)
            }
        }

        // Handle TS function types at top level: (A, B) => C
        if let arrowIndex = findTopLevelString(in: trimmed, needle: "=>") {
            let paramPart = String(trimmed[..<arrowIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
            let returnPart = String(trimmed[trimmed.index(arrowIndex, offsetBy: 2)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let paramInner = stripSurroundingParenPairs(paramPart)
            let paramChunks = splitByTopLevelCommas(paramInner)
            var extracted: [String] = []
            for chunk in paramChunks {
                let normalized = stripTSParamLabelAndDefault(chunk)
                if !normalized.isEmpty {
                    extracted.append(contentsOf: extractBaseTypesCached(from: normalized, language: language, cache: &cache, stats: stats))
                }
            }
            if !returnPart.isEmpty {
                extracted.append(contentsOf: extractBaseTypesCached(from: returnPart, language: language, cache: &cache, stats: stats))
            }
            let filtered = filterOutPrimitiveAndSpecialTypesCached(extracted, language: language, cache: &cache, stats: stats)
            return Array(Set(filtered))
        }

        // Handle TS object literal types: { a: T; b: U }
        if trimmed.hasPrefix("{") {
            let extracted = extractTSObjectLiteralTypesCached(from: trimmed, language: language, cache: &cache, stats: stats)
            let filtered = filterOutPrimitiveAndSpecialTypesCached(extracted, language: language, cache: &cache, stats: stats)
            return Array(Set(filtered))
        }

        // Split top-level '|' or '&'
        let splitted = splitTSUnionsAndIntersections(trimmed)
        let shouldCacheSplitPieces = splitted.count > 1

        var finalTypes = [String]()
        for piece in splitted {
            let trimmedPiece = piece.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedPiece.hasPrefix("{") {
                let extracted: [String] = if shouldCacheSplitPieces {
                    extractBaseTypesCached(from: trimmedPiece, language: language, cache: &cache, stats: stats)
                } else {
                    extractTSObjectLiteralTypesCached(from: trimmedPiece, language: language, cache: &cache, stats: stats)
                }
                finalTypes.append(contentsOf: extracted)
            } else {
                let subTypes: [String] = if shouldCacheSplitPieces {
                    extractBaseTypesCached(from: trimmedPiece, language: language, cache: &cache, stats: stats)
                } else {
                    extractBaseTypesNonTSCached(trimmedPiece, language: language, cache: &cache, stats: stats)
                }
                finalTypes.append(contentsOf: subTypes)
            }
        }

        let filtered = filterOutPrimitiveAndSpecialTypesCached(finalTypes, language: language, cache: &cache, stats: stats)
        return Array(Set(filtered))
    }


    static func stripTSParamLabelAndDefault(_ typeName: String) -> String {
        var cleaned = typeName.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("...") {
            cleaned = cleaned.dropFirst(3).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let eqIndex = findTopLevelChar(in: cleaned, char: "=") {
            cleaned = String(cleaned[..<eqIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let colonIndex = findTopLevelChar(in: cleaned, char: ":") {
            if let questionIndex = findTopLevelChar(in: cleaned, char: "?"),
               questionIndex < colonIndex,
               cleaned.index(after: questionIndex) != colonIndex
            {
                // Likely a conditional type (T extends U ? X : Y) - don't treat ':' as a label
            } else {
                cleaned = String(cleaned[cleaned.index(after: colonIndex)...])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        if cleaned.hasSuffix("?") {
            cleaned.removeLast()
            cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return cleaned
    }

    static func isTSLiteralType(_ typeName: String) -> Bool {
        let trimmed = typeName.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return false }
        if ["true", "false"].contains(trimmed.lowercased()) { return true }
        if (trimmed.hasPrefix("\"") && trimmed.hasSuffix("\""))
            || (trimmed.hasPrefix("'") && trimmed.hasSuffix("'"))
            || (trimmed.hasPrefix("`") && trimmed.hasSuffix("`"))
        {
            return true
        }
        if trimmed.hasSuffix("n"), Int(trimmed.dropLast()) != nil {
            return true
        }
        if Double(trimmed) != nil {
            return true
        }
        return false
    }

    static func extractTSObjectLiteralTypes(from typeName: String, language: LanguageType) -> [String] {
        var cleaned = typeName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleaned.hasPrefix("{") else { return [] }
        if cleaned.hasSuffix(";") || cleaned.hasSuffix(",") {
            cleaned.removeLast()
            cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if cleaned.hasPrefix("{") { cleaned.removeFirst() }
        if cleaned.hasSuffix("}") { cleaned.removeLast() }
        cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty { return [] }

        let members = splitByTopLevelOperator(cleaned, operators: [";", ","])
        var results: [String] = []
        for member in members {
            let trimmed = member.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            var signature = trimmed
            if signature.hasPrefix("<"),
               let gtIndex = findMatchingAngleBracket(in: signature, startIndex: signature.startIndex)
            {
                signature = String(signature[signature.index(after: gtIndex)...])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let parenIndex = findTopLevelChar(in: signature, char: "("),
               let closeIndex = findMatchingParenthesis(in: signature, startIndex: parenIndex)
            {
                if let colonBeforeParen = findTopLevelChar(in: signature, char: ":"),
                   colonBeforeParen < parenIndex
                {
                    // Property signature with a function type on the RHS; fall through to colon logic.
                } else {
                    let paramInner = signature[signature.index(after: parenIndex) ..< closeIndex]
                    let params = splitByTopLevelCommas(String(paramInner))
                    for param in params {
                        let normalized = stripTSParamLabelAndDefault(param)
                        if !normalized.isEmpty {
                            results.append(contentsOf: extractBaseTypes(from: normalized, language: language))
                        }
                    }
                    let afterParen = signature[signature.index(after: closeIndex)...]
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if !afterParen.isEmpty {
                        let afterParenString = String(afterParen)
                        if let arrowIndex = findTopLevelString(in: afterParenString, needle: "=>") {
                            let returnStart = afterParenString.index(arrowIndex, offsetBy: 2)
                            let returnType = afterParenString[returnStart...]
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                            if !returnType.isEmpty {
                                results.append(contentsOf: extractBaseTypes(from: String(returnType), language: language))
                            }
                        } else if let colonIndex = findTopLevelChar(in: afterParenString, char: ":") {
                            let returnType = afterParenString[afterParenString.index(after: colonIndex)...]
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                            if !returnType.isEmpty {
                                results.append(contentsOf: extractBaseTypes(from: String(returnType), language: language))
                            }
                        }
                    }
                    continue
                }
            }
            if let colonIndex = findTopLevelChar(in: trimmed, char: ":") {
                let after = trimmed[trimmed.index(after: colonIndex)...]
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !after.isEmpty {
                    results.append(contentsOf: extractBaseTypes(from: String(after), language: language))
                }
            }
        }
        return results
    }

    static func extractTSObjectLiteralTypesCached(
        from typeName: String,
        language: LanguageType,
        cache: inout [TypeCleanerCacheKey: [String]],
        stats: CodeMapPerformanceCollector?
    ) -> [String] {
        let objectLiteralStart = stats == nil ? 0 : CFAbsoluteTimeGetCurrent()
        defer {
            if let stats {
                recordTypeCleanerPhase(.tsObjectLiteral, duration: CFAbsoluteTimeGetCurrent() - objectLiteralStart, stats: stats)
            }
        }
        var cleaned = typeName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleaned.hasPrefix("{") else { return [] }
        if cleaned.hasSuffix(";") || cleaned.hasSuffix(",") {
            cleaned.removeLast()
            cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if cleaned.hasPrefix("{") { cleaned.removeFirst() }
        if cleaned.hasSuffix("}") { cleaned.removeLast() }
        cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty { return [] }

        let members = splitByTopLevelOperator(cleaned, operators: [";", ","])
        var results: [String] = []
        for member in members {
            let trimmed = member.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            var signature = trimmed
            if signature.hasPrefix("<"),
               let gtIndex = findMatchingAngleBracket(in: signature, startIndex: signature.startIndex)
            {
                signature = String(signature[signature.index(after: gtIndex)...])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let parenIndex = findTopLevelChar(in: signature, char: "("),
               let closeIndex = findMatchingParenthesis(in: signature, startIndex: parenIndex)
            {
                if let colonBeforeParen = findTopLevelChar(in: signature, char: ":"),
                   colonBeforeParen < parenIndex
                {
                    // Property signature with a function type on the RHS; fall through to colon logic.
                } else {
                    let paramInner = signature[signature.index(after: parenIndex) ..< closeIndex]
                    let params = splitByTopLevelCommas(String(paramInner))
                    for param in params {
                        let normalized = stripTSParamLabelAndDefault(param)
                        if !normalized.isEmpty {
                            results.append(contentsOf: extractBaseTypesCached(from: normalized, language: language, cache: &cache, stats: stats))
                        }
                    }
                    let afterParen = signature[signature.index(after: closeIndex)...]
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if !afterParen.isEmpty {
                        let afterParenString = String(afterParen)
                        if let arrowIndex = findTopLevelString(in: afterParenString, needle: "=>") {
                            let returnStart = afterParenString.index(arrowIndex, offsetBy: 2)
                            let returnType = afterParenString[returnStart...]
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                            if !returnType.isEmpty {
                                results.append(contentsOf: extractBaseTypesCached(from: String(returnType), language: language, cache: &cache, stats: stats))
                            }
                        } else if let colonIndex = findTopLevelChar(in: afterParenString, char: ":") {
                            let returnType = afterParenString[afterParenString.index(after: colonIndex)...]
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                            if !returnType.isEmpty {
                                results.append(contentsOf: extractBaseTypesCached(from: String(returnType), language: language, cache: &cache, stats: stats))
                            }
                        }
                    }
                    continue
                }
            }
            if let colonIndex = findTopLevelChar(in: trimmed, char: ":") {
                let after = trimmed[trimmed.index(after: colonIndex)...]
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !after.isEmpty {
                    results.append(contentsOf: extractBaseTypesCached(from: String(after), language: language, cache: &cache, stats: stats))
                }
            }
        }
        return results
    }

}
