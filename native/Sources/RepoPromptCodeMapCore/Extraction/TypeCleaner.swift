// Modified for mipmux: declarations relocated and cross-file access adjusted.
//
//  TypeCleaner.swift
//  RepoPrompt
//
//  Enhanced to handle TypeScript/TSX container types like Promise, Record, etc.
//  and to ensure we skip ephemeral/builtin references more effectively.
//  Now also removes method‑invocation suffixes (e.g. .withSettings()) and
//  container types (Promise, Record, etc.) within extractBaseTypes() itself.
//

import Foundation
import CoreFoundation

enum TypeCleaner {
    struct TypeCleanerCacheKey: Hashable {
        let language: LanguageType
        let raw: String
    }

    enum TypeCleanerPhase {
        case preclean
        case tsLogic
        case nonTSLogic
        case tsObjectLiteral
        case filter
        case dedup
    }


    /// Returns one or more atomic type names for a raw type string.
    /// TS/TSX types are routed through TS-specific logic.
    static func extractBaseTypes(from rawType: String, language: LanguageType) -> [String] {
        switch language {
        case .ts, .tsx:
            extractBaseTypesTS(rawType, language: language)
        default:
            extractBaseTypesNonTS(rawType, language: language)
        }
    }

    /// Cached variant to avoid repeated parsing within a file.
    static func extractBaseTypes(
        from rawType: String,
        language: LanguageType,
        cache: inout [TypeCleanerCacheKey: [String]],
        stats: CodeMapPerformanceCollector? = nil
    ) -> [String] {
        extractBaseTypesCached(from: rawType, language: language, cache: &cache, stats: stats)
    }

    static func extractBaseTypesCached(
        from rawType: String,
        language: LanguageType,
        cache: inout [TypeCleanerCacheKey: [String]],
        stats: CodeMapPerformanceCollector? = nil
    ) -> [String] {
        let activeStats = stats
        let key = TypeCleanerCacheKey(language: language, raw: rawType)
        activeStats?.typeCleanerExtractCalls += 1
        if let cached = cache[key] {
            activeStats?.typeCleanerCacheHits += 1
            return cached
        }
        activeStats?.typeCleanerCacheMisses += 1
        let languageStart = activeStats == nil ? 0 : CFAbsoluteTimeGetCurrent()
        let result: [String] = switch language {
        case .ts, .tsx:
            extractBaseTypesTSCached(rawType, language: language, cache: &cache, stats: activeStats)
        default:
            extractBaseTypesNonTSCached(rawType, language: language, cache: &cache, stats: activeStats)
        }
        if let activeStats {
            recordTypeCleanerLanguage(language, duration: CFAbsoluteTimeGetCurrent() - languageStart, stats: activeStats)
        }
        cache[key] = result
        return result
    }

    private static func recordTypeCleanerLanguage(
        _ language: LanguageType,
        duration: TimeInterval,
        stats: CodeMapPerformanceCollector
    ) {
        switch language {
        case .swift:
            stats.typeCleanerSwiftDuration += duration
            stats.typeCleanerSwiftCalls += 1
        case .ts:
            stats.typeCleanerTSDuration += duration
            stats.typeCleanerTSCalls += 1
        case .tsx:
            stats.typeCleanerTSXDuration += duration
            stats.typeCleanerTSXCalls += 1
        case .js:
            stats.typeCleanerJSDuration += duration
            stats.typeCleanerJSCalls += 1
        default:
            stats.typeCleanerOtherLanguageDuration += duration
            stats.typeCleanerOtherLanguageCalls += 1
        }
    }

    static func recordTypeCleanerPhase(
        _ phase: TypeCleanerPhase,
        duration: TimeInterval,
        stats: CodeMapPerformanceCollector
    ) {
        switch phase {
        case .preclean:
            stats.typeCleanerPrecleanDuration += duration
            stats.typeCleanerPrecleanCount += 1
        case .tsLogic:
            stats.typeCleanerTSLogicDuration += duration
            stats.typeCleanerTSLogicCount += 1
        case .nonTSLogic:
            stats.typeCleanerNonTSLogicDuration += duration
            stats.typeCleanerNonTSLogicCount += 1
        case .tsObjectLiteral:
            stats.typeCleanerTSObjectLiteralDuration += duration
            stats.typeCleanerTSObjectLiteralCount += 1
        case .filter:
            stats.typeCleanerFilterDuration += duration
            stats.typeCleanerFilterCount += 1
        case .dedup:
            stats.typeCleanerDedupDuration += duration
            stats.typeCleanerDedupCount += 1
        }
    }

    // MARK: - Non‑TypeScript/TSX Logic

    static func extractBaseTypesNonTS(_ rawType: String, language: LanguageType) -> [String] {
        var type = rawType.trimmingCharacters(in: .whitespacesAndNewlines)
        type = removeComments(from: type, language: language)
        if language == .swift {
            type = removeOpaqueTypeKeyword(from: type, language: language)
            type = normalizeSwiftType(type)
        }

        // Remove any trailing `.methodCall(...)` or `.property` patterns (including optional generics)
        type = removeMethodCalls(type)

        // Remove unmatched < or >
        type = stripUnmatchedAngleBrackets(type)
        type = stripUnbalancedParens(type)
        type = stripSurroundingParenPairs(type)
        type = stripTrailingBracesAndParens(type)

        if language == .swift {
            let intersections = splitSwiftIntersections(type)
            if intersections.count > 1 {
                let extracted = intersections.flatMap { extractBaseTypesNonTS($0, language: language) }
                let deduped = Array(Set(extracted.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }))
                return filterOutPrimitiveAndSpecialTypes(deduped, language: language)
            }
        }

        var results: [String] = []

        // 1) Swift closure / function-type => (A, B) -> C
        if let arrowIndex = findTopLevelString(in: type, needle: "->") {
            let paramPart = String(type[..<arrowIndex]).trimmingCharacters(in: .whitespaces)
            let returnPart = String(type[arrowIndex...].dropFirst(2)).trimmingCharacters(in: .whitespaces)

            let paramInner = stripSurroundingParenPairs(paramPart)
            let paramTypes = splitByTopLevelCommas(paramInner)
                .flatMap { extractBaseTypes(from: $0, language: language) }
            let retTypes = extractBaseTypes(from: returnPart, language: language)
            results = paramTypes + retTypes
        }
        // 2) Repeatedly peel off top-level generics with <...>
        else {
            var workingType = type
            var didExtractGeneric = false

            repeat {
                didExtractGeneric = false
                if let ltIndex = findTopLevelChar(in: workingType, char: "<"),
                   let gtIndex = findMatchingAngleBracket(in: workingType, startIndex: ltIndex)
                {
                    let before = String(workingType[..<ltIndex]).trimmingCharacters(in: .whitespaces)
                    let inside = String(workingType[workingType.index(after: ltIndex) ..< gtIndex])

                    let outsideCleaned = stripPointerOptional(before, language: language)
                    let insideSplit = splitByTopLevelCommas(inside)
                        .flatMap { extractBaseTypes(from: $0, language: language) }

                    results.append(contentsOf: [outsideCleaned] + insideSplit)

                    // Move on to any remainder after the matching '>'
                    let remainder = workingType[gtIndex...].dropFirst().trimmingCharacters(in: .whitespaces)
                    workingType = remainder
                    didExtractGeneric = true
                }
            } while didExtractGeneric && !workingType.isEmpty

            // If nothing got extracted via generics, or there's leftover
            if !didExtractGeneric {
                // Check parentheses or bracket forms
                if let parenIndex = findTopLevelChar(in: workingType, char: "("),
                   let closeIndex = findMatchingParenthesis(in: workingType, startIndex: parenIndex)
                {
                    let inside = String(workingType[workingType.index(after: parenIndex) ..< closeIndex])
                    let subSplit = splitByTopLevelCommas(inside)
                        .flatMap { extractBaseTypes(from: $0, language: language) }
                    results = subSplit.isEmpty ? [workingType] : subSplit
                } else if let sqIndex = findTopLevelChar(in: workingType, char: "["),
                          let closeSqIndex = findMatchingSquareBracket(in: workingType, startIndex: sqIndex)
                {
                    let inside = String(workingType[workingType.index(after: sqIndex) ..< closeSqIndex])
                        .trimmingCharacters(in: .whitespacesAndNewlines)

                    // dictionary style => [K: V]
                    if findTopLevelChar(in: inside, char: ":") != nil {
                        let dictParts = splitByTopLevelColon(inside)
                        let keySide = dictParts.first ?? ""
                        let valSide = dictParts.count > 1 ? dictParts[1] : ""

                        let keyTypes = extractBaseTypes(from: keySide, language: language)
                        let valTypes = extractBaseTypes(from: valSide, language: language)
                        results = keyTypes + valTypes
                    } else {
                        // array style => [T]
                        results = extractBaseTypes(from: inside, language: language)
                    }
                } else {
                    // fallback
                    let final = stripPointerOptional(workingType, language: language)
                    let cleaned = removeTrailingStandaloneBrackets(final)
                    results = [cleaned.trimmingCharacters(in: .whitespacesAndNewlines)]
                }
            } else {
                // We did parse out some generics. The leftover workingType might still contain more.
                if !workingType.isEmpty {
                    // Recurse the leftover string
                    let leftoverTypes = extractBaseTypesNonTS(workingType, language: language)
                    results.append(contentsOf: leftoverTypes)
                }
            }
        }

        let deduped = Array(Set(results.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }))
        return filterOutPrimitiveAndSpecialTypes(deduped, language: language)
    }

    static func extractBaseTypesNonTSCached(
        _ rawType: String,
        language: LanguageType,
        cache: inout [TypeCleanerCacheKey: [String]],
        stats: CodeMapPerformanceCollector?
    ) -> [String] {
        let precleanStart = stats == nil ? 0 : CFAbsoluteTimeGetCurrent()
        var type = rawType.trimmingCharacters(in: .whitespacesAndNewlines)
        type = removeComments(from: type, language: language)
        if language == .swift {
            type = removeOpaqueTypeKeyword(from: type, language: language)
            type = normalizeSwiftType(type)
        }

        // Remove any trailing `.methodCall(...)` or `.property` patterns (including optional generics)
        type = removeMethodCalls(type)

        // Remove unmatched < or >
        type = stripUnmatchedAngleBrackets(type)
        type = stripUnbalancedParens(type)
        type = stripSurroundingParenPairs(type)
        type = stripTrailingBracesAndParens(type)
        if let stats {
            recordTypeCleanerPhase(.preclean, duration: CFAbsoluteTimeGetCurrent() - precleanStart, stats: stats)
        }

        let logicStart = stats == nil ? 0 : CFAbsoluteTimeGetCurrent()
        defer {
            if let stats {
                recordTypeCleanerPhase(.nonTSLogic, duration: CFAbsoluteTimeGetCurrent() - logicStart, stats: stats)
            }
        }

        if language == .swift {
            let intersections = splitSwiftIntersections(type)
            if intersections.count > 1 {
                let extracted = intersections.flatMap {
                    extractBaseTypesCached(from: $0, language: language, cache: &cache, stats: stats)
                }
                let deduped = Array(Set(extracted.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }))
                return filterOutPrimitiveAndSpecialTypesCached(deduped, language: language, cache: &cache, stats: stats)
            }
        }

        var results: [String] = []

        // 1) Swift closure / function-type => (A, B) -> C
        if let arrowIndex = findTopLevelString(in: type, needle: "->") {
            let paramPart = String(type[..<arrowIndex]).trimmingCharacters(in: .whitespaces)
            let returnPart = String(type[arrowIndex...].dropFirst(2)).trimmingCharacters(in: .whitespaces)

            let paramInner = stripSurroundingParenPairs(paramPart)
            let paramTypes = splitByTopLevelCommas(paramInner)
                .flatMap { extractBaseTypesCached(from: $0, language: language, cache: &cache, stats: stats) }
            let retTypes = extractBaseTypesCached(from: returnPart, language: language, cache: &cache, stats: stats)
            results = paramTypes + retTypes
        }
        // 2) Repeatedly peel off top-level generics with <...>
        else {
            var workingType = type
            var didExtractGeneric = false

            repeat {
                didExtractGeneric = false
                if let ltIndex = findTopLevelChar(in: workingType, char: "<"),
                   let gtIndex = findMatchingAngleBracket(in: workingType, startIndex: ltIndex)
                {
                    let before = String(workingType[..<ltIndex]).trimmingCharacters(in: .whitespaces)
                    let inside = String(workingType[workingType.index(after: ltIndex) ..< gtIndex])

                    let outsideCleaned = stripPointerOptional(before, language: language)
                    let insideSplit = splitByTopLevelCommas(inside)
                        .flatMap { extractBaseTypesCached(from: $0, language: language, cache: &cache, stats: stats) }

                    results.append(contentsOf: [outsideCleaned] + insideSplit)

                    // Move on to any remainder after the matching '>'
                    let remainder = workingType[gtIndex...].dropFirst().trimmingCharacters(in: .whitespaces)
                    workingType = remainder
                    didExtractGeneric = true
                }
            } while didExtractGeneric && !workingType.isEmpty

            // If nothing got extracted via generics, or there's leftover
            if !didExtractGeneric {
                // Check parentheses or bracket forms
                if let parenIndex = findTopLevelChar(in: workingType, char: "("),
                   let closeIndex = findMatchingParenthesis(in: workingType, startIndex: parenIndex)
                {
                    let inside = String(workingType[workingType.index(after: parenIndex) ..< closeIndex])
                    let subSplit = splitByTopLevelCommas(inside)
                        .flatMap { extractBaseTypesCached(from: $0, language: language, cache: &cache, stats: stats) }
                    results = subSplit.isEmpty ? [workingType] : subSplit
                } else if let sqIndex = findTopLevelChar(in: workingType, char: "["),
                          let closeSqIndex = findMatchingSquareBracket(in: workingType, startIndex: sqIndex)
                {
                    let inside = String(workingType[workingType.index(after: sqIndex) ..< closeSqIndex])
                        .trimmingCharacters(in: .whitespacesAndNewlines)

                    // dictionary style => [K: V]
                    if findTopLevelChar(in: inside, char: ":") != nil {
                        let dictParts = splitByTopLevelColon(inside)
                        let keySide = dictParts.first ?? ""
                        let valSide = dictParts.count > 1 ? dictParts[1] : ""

                        let keyTypes = extractBaseTypesCached(from: keySide, language: language, cache: &cache, stats: stats)
                        let valTypes = extractBaseTypesCached(from: valSide, language: language, cache: &cache, stats: stats)
                        results = keyTypes + valTypes
                    } else {
                        // array style => [T]
                        results = extractBaseTypesCached(from: inside, language: language, cache: &cache, stats: stats)
                    }
                } else {
                    // fallback
                    let final = stripPointerOptional(workingType, language: language)
                    let cleaned = removeTrailingStandaloneBrackets(final)
                    results = [cleaned.trimmingCharacters(in: .whitespacesAndNewlines)]
                }
            } else {
                // We did parse out some generics. The leftover workingType might still contain more.
                if !workingType.isEmpty {
                    // Recurse the leftover string
                    let leftoverTypes = extractBaseTypesCached(from: workingType, language: language, cache: &cache, stats: stats)
                    results.append(contentsOf: leftoverTypes)
                }
            }
        }

        let deduped = Array(Set(results.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }))
        return filterOutPrimitiveAndSpecialTypesCached(deduped, language: language, cache: &cache, stats: stats)
    }

}
