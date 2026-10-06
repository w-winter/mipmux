// Modified for smip: extraction state and capture handlers separated.
//
//  CodeMapGenerator.swift
//  RepoPrompt
//
//  Created by Eric Provencher on 2025-02-08.
//

import Foundation
import CoreFoundation
#if CODEMAP_PERF_SIGNPOSTS
    import os
#endif
import SwiftTreeSitter

struct CodeMapGenerator {
    static let debug = false

    /// Maximum continuation lines appended after the first JS/TS declaration line.
    /// This changes extracted artifact content and is therefore part of pipeline identity.
    static let jstsMaxAppendedContinuationLines = 80

    // MARK: - Debug Configuration

    /// Controls detailed logging for code map generation
    /// Set to true to enable extensive logging for debugging lightweight language parsing
    static let debugLogging = false

    // MARK: - Perf Signposts

    #if CODEMAP_PERF_SIGNPOSTS
        typealias SignpostToken = OSSignpostID
    #else
        typealias SignpostToken = UInt8
    #endif

    enum Signpost {
        #if CODEMAP_PERF_SIGNPOSTS
            static let log = OSLog(subsystem: "com.repoprompt", category: "codemap")
        #endif

        @inline(__always)
        static func begin(_ name: StaticString) -> SignpostToken {
            #if CODEMAP_PERF_SIGNPOSTS
                let id = OSSignpostID(log: log)
                os_signpost(.begin, log: log, name: name, signpostID: id)
                return id
            #else
                return 0
            #endif
        }

        @inline(__always)
        static func end(_ name: StaticString, _ token: SignpostToken) {
            #if CODEMAP_PERF_SIGNPOSTS
                os_signpost(.end, log: log, name: name, signpostID: token)
            #endif
        }
    }

    enum CaptureLoopAttributionCategory {
        case swiftStrategy
        case tsStrategy
        case interfaceHeuristic
        case importExport
        case typeAlias
        case enumMacro
        case function
        case variable
        case skipped
        case unclassified
    }

    static func recordCaptureLoopLineAdvance(
        duration: TimeInterval,
        collectCounters: Bool,
        perfStats: CodeMapPerformanceCollector?
    ) {
        guard let perfStats else { return }
        perfStats.captureLoopLineAdvanceDuration += duration
        if collectCounters {
            perfStats.captureLoopLineAdvanceCount += 1
        }
    }

    static func recordCaptureLoopAttribution(
        category: CaptureLoopAttributionCategory,
        duration: TimeInterval,
        collectCounters: Bool,
        perfStats: CodeMapPerformanceCollector?
    ) {
        guard let perfStats else { return }
        switch category {
        case .swiftStrategy:
            perfStats.captureLoopSwiftStrategyDuration += duration
            if collectCounters { perfStats.captureLoopSwiftStrategyCount += 1 }
        case .tsStrategy:
            perfStats.captureLoopTSStrategyDuration += duration
            if collectCounters { perfStats.captureLoopTSStrategyCount += 1 }
        case .interfaceHeuristic:
            perfStats.captureLoopInterfaceHeuristicDuration += duration
            if collectCounters { perfStats.captureLoopInterfaceHeuristicCount += 1 }
        case .importExport:
            perfStats.captureLoopImportExportDuration += duration
            if collectCounters { perfStats.captureLoopImportExportCount += 1 }
        case .typeAlias:
            perfStats.captureLoopTypeAliasDuration += duration
            if collectCounters { perfStats.captureLoopTypeAliasCount += 1 }
        case .enumMacro:
            perfStats.captureLoopEnumMacroDuration += duration
            if collectCounters { perfStats.captureLoopEnumMacroCount += 1 }
        case .function:
            perfStats.captureLoopFunctionDuration += duration
            if collectCounters { perfStats.captureLoopFunctionCount += 1 }
        case .variable:
            perfStats.captureLoopVariableDuration += duration
            if collectCounters { perfStats.captureLoopVariableCount += 1 }
        case .skipped:
            perfStats.captureLoopSkippedDuration += duration
            if collectCounters { perfStats.captureLoopSkippedCount += 1 }
        case .unclassified:
            perfStats.captureLoopUnclassifiedDuration += duration
            if collectCounters { perfStats.captureLoopUnclassifiedCount += 1 }
        }
    }

    enum FallbackFunctionAttributionCategory {
        case declaration
        case jstsSignature
        case nameExtraction
        case lteParse
        case tsFastPath
        case referencedTypes
        case routing
        case modelInsertion
        case skipped
    }

    static func recordFallbackFunctionAttribution(
        category: FallbackFunctionAttributionCategory,
        duration: TimeInterval,
        collectCounters: Bool,
        perfStats: CodeMapPerformanceCollector?
    ) {
        guard let perfStats else { return }
        switch category {
        case .declaration:
            perfStats.fallbackFunctionDeclarationDuration += duration
            if collectCounters { perfStats.fallbackFunctionDeclarationCount += 1 }
        case .jstsSignature:
            perfStats.fallbackFunctionJSTSSignatureDuration += duration
            if collectCounters { perfStats.fallbackFunctionJSTSSignatureCount += 1 }
        case .nameExtraction:
            perfStats.fallbackFunctionNameExtractionDuration += duration
            if collectCounters { perfStats.fallbackFunctionNameExtractionCount += 1 }
        case .lteParse:
            perfStats.fallbackFunctionLTEParseDuration += duration
            if collectCounters { perfStats.fallbackFunctionLTEParseCount += 1 }
        case .tsFastPath:
            perfStats.fallbackFunctionTSFastPathDuration += duration
            if collectCounters { perfStats.fallbackFunctionTSFastPathCount += 1 }
        case .referencedTypes:
            perfStats.fallbackFunctionReferencedTypesDuration += duration
            if collectCounters { perfStats.fallbackFunctionReferencedTypesCount += 1 }
        case .routing:
            perfStats.fallbackFunctionRoutingDuration += duration
            if collectCounters { perfStats.fallbackFunctionRoutingCount += 1 }
        case .modelInsertion:
            perfStats.fallbackFunctionModelInsertionDuration += duration
            if collectCounters { perfStats.fallbackFunctionModelInsertionCount += 1 }
        case .skipped:
            perfStats.fallbackFunctionSkippedDuration += duration
            if collectCounters { perfStats.fallbackFunctionSkippedCount += 1 }
        }
    }

    // MARK: - Range Helpers

    /// Checks if inner range is fully contained within outer range
    static func rangeContains(_ outer: NSRange, _ inner: NSRange) -> Bool {
        inner.location >= outer.location &&
            NSMaxRange(inner) <= NSMaxRange(outer)
    }

    /// Determines if a language should skip synthetic main class creation
    private static func shouldSkipSyntheticMainClass(for language: LanguageType) -> Bool {
        switch language {
        case .swift, .ts, .tsx, .js, .c, .cpp, .go, .rust, .python, .php, .ruby:
            true // These languages should populate functions[] and globalVars[] directly
        default:
            false
        }
    }

    struct GenerationOutput {
        let imports: [String]
        let exports: [String]
        let enums: [EnumInfo]
        let aliases: [TypeAliasInfo]
        let literalUnions: [String]
        let macros: [String]
        let referencedTypes: [String]
        let globalFunctions: [FunctionInfo]
        let globalVariables: [VariableInfo]
        let classesByLine: [Int: ClassInfo]
        let interfacesByLine: [Int: InterfaceInfo]
    }

    static func generateSyntaxArtifact(
        from namedRanges: [NamedRange],
        content: String,
        language: LanguageType,
        perfOptions: CodeMapPerfOptions = .disabled,
        perfStats: CodeMapPerformanceCollector? = nil
    ) -> CodeMapSyntaxArtifact? {
        let output = extractCodeMap(
            from: namedRanges,
            content: content,
            language: language,
            terminator: declarationTerminator(for: language),
            perfOptions: perfOptions,
            perfStats: perfStats
        )
        return makeSyntaxArtifact(
            from: output,
            performanceCollector: perfOptions.enabled ? perfStats : nil
        )
    }

    private static func declarationTerminator(for language: LanguageType) -> Character {
        switch language {
        case .python: ":"
        case .ruby: "\0"
        default: "{"
        }
    }

    private static func extractCodeMap(
        from namedRanges: [NamedRange],
        content: String,
        language supportedLanguage: LanguageType,
        terminator: Character,
        perfOptions: CodeMapPerfOptions,
        perfStats: CodeMapPerformanceCollector?
    ) -> GenerationOutput {
        CodeMapExtractionRuntime(
            from: namedRanges, content: content, language: supportedLanguage,
            terminator: terminator, perfOptions: perfOptions, perfStats: perfStats
        ).run()
    }

    private static func makeSyntaxArtifact(
        from output: GenerationOutput,
        performanceCollector: CodeMapPerformanceCollector?
    ) -> CodeMapSyntaxArtifact? {
        let finalizationStart = performanceCollector.map { _ in CFAbsoluteTimeGetCurrent() }
        defer {
            if let finalizationStart {
                performanceCollector?.artifactFinalizationDuration +=
                    CFAbsoluteTimeGetCurrent() - finalizationStart
            }
        }

        let classes = finalizedClasses(output.classesByLine)
        let interfaces = finalizedInterfaces(output.interfacesByLine)
        let meaningfulStart = performanceCollector.map { _ in CFAbsoluteTimeGetCurrent() }
        let meaningful = hasMeaningfulContent(
            output: output,
            classes: classes,
            interfaces: interfaces,
            functions: output.globalFunctions,
            globalVars: output.globalVariables
        )
        if let meaningfulStart {
            performanceCollector?.artifactMeaningfulContentCheckDuration +=
                CFAbsoluteTimeGetCurrent() - meaningfulStart
        }
        guard meaningful else { return nil }

        let artifactStart = performanceCollector.map { _ in CFAbsoluteTimeGetCurrent() }
        let artifact = CodeMapSyntaxArtifact(
            imports: output.imports,
            exports: output.exports,
            classes: classes,
            interfaces: interfaces,
            aliases: output.aliases,
            literalUnions: output.literalUnions,
            functions: output.globalFunctions,
            enums: output.enums,
            globalVars: output.globalVariables,
            macros: output.macros,
            referencedTypes: output.referencedTypes
        )
        if let artifactStart {
            performanceCollector?.fileAPIInitDuration += CFAbsoluteTimeGetCurrent() - artifactStart
            performanceCollector?.artifactFinalClassCount += classes.count
            performanceCollector?.artifactFinalInterfaceCount += interfaces.count
            performanceCollector?.artifactFinalFunctionCount += output.globalFunctions.count
            performanceCollector?.artifactFinalGlobalVariableCount += output.globalVariables.count
        }
        return artifact
    }

    private static func finalizedClasses(_ classesByLine: [Int: ClassInfo]) -> [ClassInfo] {
        classesByLine.keys.sorted().compactMap { classesByLine[$0] }
            .filter { !$0.methods.isEmpty || !$0.properties.isEmpty }
    }

    private static func finalizedInterfaces(_ interfacesByLine: [Int: InterfaceInfo]) -> [InterfaceInfo] {
        interfacesByLine.keys.sorted().compactMap { interfacesByLine[$0] }
            .filter { !$0.methods.isEmpty || !$0.properties.isEmpty }
    }

    private static func hasMeaningfulContent(
        output: GenerationOutput,
        classes: [ClassInfo],
        interfaces: [InterfaceInfo],
        functions: [FunctionInfo],
        globalVars: [VariableInfo]
    ) -> Bool {
        !output.imports.isEmpty || !output.exports.isEmpty || !classes.isEmpty ||
            !functions.isEmpty || !globalVars.isEmpty || !output.enums.isEmpty ||
            !output.macros.isEmpty || !interfaces.isEmpty || !output.aliases.isEmpty ||
            !output.literalUnions.isEmpty
    }

    // MARK: - Optimized Helpers

}
