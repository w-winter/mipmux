// Modified for mipmux: extraction state and capture handlers separated.
import Foundation
import CoreFoundation
import SwiftTreeSitter

final class CodeMapExtractionRuntime {
    struct ClassBoundary { let startLine: Int
        let name: String
        let range: NSRange?
    }
    struct InterfaceBoundary { let startLine: Int
        let name: String
        let range: NSRange?
    }
    struct RustImplBoundary { let range: NSRange
        let targetTypeName: String
        let startLine: Int
    }

    let content: String
    let supportedLanguage: LanguageType
    let terminator: Character
    let isLightweightLang: Bool
    let isTSLike: Bool
    let isJSLike: Bool
    let isJSTS: Bool
    let nsContent: NSString
    let boundaries: [Int]
    let contentLength: Int
    var lineCache: CodeMapGenerator.LineCache
    var extractionMemo: CodeMapExtractionMemo
    let activePerfOptions: CodeMapPerfOptions
    let activePerfStats: CodeMapPerformanceCollector?
    let perfEnabled: Bool
    let perfCollectCounters: Bool
    let captureIndex: CodeMapCaptureIndex
    let sortedCaps: [CodeMapIndexedCapture]
    var imports: [String]
    var exports: [String]
    var enums: [EnumInfo]
    var aliases: [TypeAliasInfo]
    var literalUnions: [String]
    var macros: [String]
    var referencedTypes: ReferencedTypesAccumulator
    var globalFunctions: [FunctionInfo]
    var globalVariables: [VariableInfo]
    var classesByLine: [Int: ClassInfo]
    var interfaceBoundaries: [Int: InterfaceInfo]
    var processedVarLines: Set<Int>
    var processedMultiVarKeys: Set<String>
    var processedFunctionLines: Set<Int>
    var currentEnum: EnumInfo?
    var seenImportExport: Set<String>
    let classBoundaries: [ClassBoundary]
    let usesRangeContainmentForClasses: Bool
    let pythonEnumDeclsByRange: [(range: NSRange, name: String)]
    let interfaceBoundaryList: [InterfaceBoundary]
    let usesRangeContainmentForInterfaces: Bool
    let rustStructNames: Set<String>
    let classBoundariesByRange: [ClassBoundary]
    let interfaceBoundaryListByRange: [InterfaceBoundary]
    let rustImplBoundariesByRange: [RustImplBoundary]
    let swiftContext: SwiftCodeMapStrategy.Context?
    let tsContext: TypeScriptCodeMapStrategy.Context?
    let usesTSRangeContainment: Bool

    init(
        from namedRanges: [NamedRange],
        content: String,
        language supportedLanguage: LanguageType,
        terminator: Character,
        perfOptions: CodeMapPerfOptions,
        perfStats: CodeMapPerformanceCollector?
    ) {
        // ------------------------------------------------------------------
        // 0) Early setup & helpers
        // ------------------------------------------------------------------
        let isLightweightLang = CodeMapSyntaxEngine.isLightweight(language: supportedLanguage)

        // BUG FIX #1: Split TS/TSX from JS for proper routing
        let isTSLike = (supportedLanguage == .ts || supportedLanguage == .tsx)
        let isJSLike = (supportedLanguage == .js)
        let isJSTS = isTSLike || isJSLike // For string-based heuristics

        if CodeMapGenerator.debugLogging {
            print("🔍 [CodeMapGenerator] Starting code map generation")
            print("🏷️  Explicit language: \(supportedLanguage)")
            print("⚡️ Lightweight mode: \(isLightweightLang)")
            print("🎯 Terminator: '\(terminator)'")
            print("📊 Total named ranges: \(namedRanges.count)")
            print("📏 Content length: \(content.count) characters")
            print("📝 Content line count: \(content.components(separatedBy: .newlines).count)")
            print("📘 isTSLike: \(isTSLike), isJSLike: \(isJSLike)")
        }

        let nsContent = content as NSString
        let boundaries = CodeMapGenerator.computeLineBoundaries(content: content)
        let contentLength = nsContent.length
        var lineCache = CodeMapGenerator.LineCache(nsContent: nsContent, boundaries: boundaries, contentLength: contentLength)
        let extractionMemo = CodeMapExtractionMemo()
        let activePerfOptions = perfOptions
        let activePerfStats = perfStats
        let perfEnabled = activePerfOptions.enabled
        let perfCollectCounters = activePerfOptions.collectCounters

        // Build capture index for efficient lookups
        let indexToken = CodeMapGenerator.Signpost.begin("codemap.index")
        let indexStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
        let captureIndex = CodeMapCaptureIndex(
            namedRanges,
            performanceCollector: perfEnabled ? activePerfStats : nil
        )
        if perfEnabled {
            activePerfStats?.captureIndexDuration += (CFAbsoluteTimeGetCurrent() - indexStart)
        }
        let sortedCaps = captureIndex.all
        CodeMapGenerator.Signpost.end("codemap.index", indexToken)

        if CodeMapGenerator.debugLogging {
            print("🗂️  Line boundaries computed: \(boundaries.count) lines")
            print("🔄 Named ranges indexed: \(sortedCaps.count) captures")

            // Log all captured ranges for debugging
            print("📋 All captured ranges:")
            for (index, cap) in sortedCaps.enumerated() {
                let lineNo = CodeMapGenerator.lineNumber(for: cap.range.location, using: boundaries)
                let captured = CodeMapGenerator.substring(content: content, range: cap.range)
                print("  [\(index)] \(cap.name) @ line \(lineNo): '\(captured.prefix(50))\(captured.count > 50 ? "..." : "")'")
            }
        }

        // ------------------------------------------------------------------
        // 1)  Capture buckets
        // ------------------------------------------------------------------
        let imports: [String] = []
        let exports: [String] = []
        let enums: [EnumInfo] = []
        let aliases: [TypeAliasInfo] = []
        let literalUnions: [String] = []
        let macros: [String] = []
        let referencedTypes = ReferencedTypesAccumulator(language: supportedLanguage, stats: activePerfStats, perfOptions: activePerfOptions)
        let globalFunctions: [FunctionInfo] = []
        let globalVariables: [VariableInfo] = []
        var classesByLine: [Int: ClassInfo] = [:]
        var interfaceBoundaries: [Int: InterfaceInfo] = [:] // key = startLine

        let processedVarLines = Set<Int>()
        let processedMultiVarKeys = Set<String>()
        let processedFunctionLines = Set<Int>() // Track function lines to avoid duplicate arrow functions
        let currentEnum: EnumInfo? = nil
        let seenImportExport = Set<String>()

        // ------------------------------------------------------------------
        // 2)  Build class boundaries only (interfaces ≠ classes)
        // ------------------------------------------------------------------
        var classBoundaries: [ClassBoundary] = []
        var usesRangeContainmentForClasses = false

        if CodeMapGenerator.debugLogging {
            print("\n🏗️  [Phase 2] Building class boundaries and interfaces")
        }

        // — real classes (skip for Swift and TS/TSX - they use range-based strategies) —
        if supportedLanguage != .swift, !isTSLike {
            // Prefer range-based class boundaries when available
            let classDeclCaps = captureIndex.captures(named: "type.class.decl")
            let enumDeclCaps = captureIndex.captures(named: "type.enum.decl")
            var declCaps: [CodeMapIndexedCapture] = []
            declCaps.reserveCapacity(classDeclCaps.count + enumDeclCaps.count)
            declCaps.append(contentsOf: classDeclCaps)
            declCaps.append(contentsOf: enumDeclCaps)
            if !declCaps.isEmpty {
                usesRangeContainmentForClasses = true
                for cap in declCaps {
                    // Find the name within this declaration
                    let nameCap =
                        captureIndex.firstCapture(named: "type.class", containedIn: cap.range) ??
                        captureIndex.firstCapture(named: "class", containedIn: cap.range) ??
                        captureIndex.firstCapture(named: "type.struct", containedIn: cap.range) ??
                        captureIndex.firstCapture(named: "type.trait", containedIn: cap.range) ??
                        captureIndex.firstCapture(named: "type.enum", containedIn: cap.range)
                    guard let resolvedName = nameCap.map({ CodeMapGenerator.substring(content: content, range: $0.range) }),
                          !resolvedName.isEmpty
                    else { continue }
                    let ln = CodeMapGenerator.lineNumber(for: cap.range.location, using: boundaries)
                    classBoundaries.append(.init(startLine: ln, name: resolvedName, range: cap.range))
                    if CodeMapGenerator.debugLogging {
                        print("🏛️  Found class (range): '\(resolvedName)' at line \(ln)")
                    }
                }
            } else {
                for cap in sortedCaps where cap.name == "class" || cap.name == "type.class" || cap.name == "type.struct" || cap.name == "type.trait" {
                    let ln = CodeMapGenerator.lineNumber(for: cap.range.location, using: boundaries)
                    let cls = CodeMapGenerator.substring(content: content, range: cap.range)
                    classBoundaries.append(.init(startLine: ln, name: cls, range: nil))
                    if CodeMapGenerator.debugLogging {
                        print("🏛️  Found class: '\(cls)' at line \(ln)")
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // 2b) Python enum declaration ranges (for routing enum members)
        // ------------------------------------------------------------------
        var pythonEnumDecls: [(range: NSRange, name: String)] = []
        if supportedLanguage == .python {
            for decl in captureIndex.captures(named: "type.class.decl") {
                let declLine = lineCache.line(for: decl.range.location)
                if !CodeMapGenerator.RegexCache.pythonEnumClass.matches(declLine) {
                    continue
                }
                if let nameCap = captureIndex.firstCapture(named: "type.class", containedIn: decl.range) {
                    let name = CodeMapGenerator.substring(content: content, range: nameCap.range)
                    if !name.isEmpty {
                        pythonEnumDecls.append((range: decl.range, name: name))
                    }
                }
            }
        }
        let pythonEnumDeclsByRange = pythonEnumDecls.sorted { lhs, rhs in
            if lhs.range.location != rhs.range.location { return lhs.range.location < rhs.range.location }
            return lhs.range.length < rhs.range.length
        }

        // — interfaces recorded separately (skip for TS/TSX - handled by strategy) —
        var interfaceBoundaryList: [InterfaceBoundary] = []
        var usesRangeContainmentForInterfaces = false

        if !isTSLike {
            let interfaceDeclCaps = captureIndex.captures(named: "type.interface.decl")
            if !interfaceDeclCaps.isEmpty {
                usesRangeContainmentForInterfaces = true
                for cap in interfaceDeclCaps {
                    let nameCap =
                        captureIndex.firstCapture(named: "type.interface", containedIn: cap.range) ??
                        captureIndex.firstCapture(named: "interface", containedIn: cap.range)
                    guard let resolvedName = nameCap.map({ CodeMapGenerator.substring(content: content, range: $0.range) }),
                          !resolvedName.isEmpty
                    else { continue }
                    let ln = CodeMapGenerator.lineNumber(for: cap.range.location, using: boundaries)
                    interfaceBoundaries[ln] = InterfaceInfo(name: resolvedName, properties: [], methods: [])
                    interfaceBoundaryList.append(.init(startLine: ln, name: resolvedName, range: cap.range))
                    if CodeMapGenerator.debugLogging {
                        print("🔌 Found interface (range) '\(resolvedName)' at line \(ln)")
                    }
                }
            } else {
                for cap in sortedCaps where cap.name == "interface" || cap.name == "type.interface" {
                    let ln = CodeMapGenerator.lineNumber(for: cap.range.location, using: boundaries)
                    let name = CodeMapGenerator.substring(content: content, range: cap.range)
                    interfaceBoundaries[ln] = InterfaceInfo(name: name, properties: [], methods: [])
                    interfaceBoundaryList.append(.init(startLine: ln, name: name, range: nil))
                    if CodeMapGenerator.debugLogging {
                        print("🔌 Found interface '\(name)' at line \(ln)")
                    }
                }
            }
        }

        classBoundaries.sort { $0.startLine < $1.startLine }
        for b in classBoundaries {
            classesByLine[b.startLine] = ClassInfo(name: b.name, methods: [], properties: [])
        }

        var rustImplBoundaries: [RustImplBoundary] = []
        var rustStructNames: Set<String> = []
        if supportedLanguage == .rust {
            rustStructNames = Set(
                captureIndex.captures(named: "type.struct")
                    .map { CodeMapGenerator.substring(content: content, range: $0.range) }
            )
            for decl in captureIndex.captures(named: "rust.impl.decl") {
                guard let nameCap = captureIndex.firstCapture(named: "rust.impl.type", containedIn: decl.range) else { continue }
                let targetName = CodeMapGenerator.substring(content: content, range: nameCap.range)
                if targetName.isEmpty { continue }
                let ln = CodeMapGenerator.lineNumber(for: decl.range.location, using: boundaries)
                rustImplBoundaries.append(.init(range: decl.range, targetTypeName: targetName, startLine: ln))
            }
        }

        if !interfaceBoundaryList.isEmpty {
            interfaceBoundaryList.sort { $0.startLine < $1.startLine }
        }
        let classBoundariesByRange = classBoundaries.filter { $0.range != nil }.sorted { lhs, rhs in
            let lhsRange = lhs.range!
            let rhsRange = rhs.range!
            if lhsRange.location != rhsRange.location { return lhsRange.location < rhsRange.location }
            return lhsRange.length < rhsRange.length
        }
        let interfaceBoundaryListByRange = interfaceBoundaryList.filter { $0.range != nil }.sorted { lhs, rhs in
            let lhsRange = lhs.range!
            let rhsRange = rhs.range!
            if lhsRange.location != rhsRange.location { return lhsRange.location < rhsRange.location }
            return lhsRange.length < rhsRange.length
        }
        let rustImplBoundariesByRange = rustImplBoundaries.sorted { lhs, rhs in
            if lhs.range.location != rhs.range.location { return lhs.range.location < rhs.range.location }
            return lhs.range.length < rhs.range.length
        }

        if CodeMapGenerator.debugLogging {
            print("📊 Class boundaries summary:")
            print("   • Classes found: \(classBoundaries.count)")
            print("   • Interfaces found: \(interfaceBoundaries.count)")
            if !classBoundaries.isEmpty {
                print("   • Class order by line:")
                for b in classBoundaries {
                    print("     - '\(b.name)' @ line \(b.startLine)")
                }
            }
        }


        // ------------------------------------------------------------------
        // 2.5) Swift-specific: Build type boundaries with full ranges (via strategy)
        // ------------------------------------------------------------------
        var swiftContext: SwiftCodeMapStrategy.Context? = nil

        if supportedLanguage == .swift {
            if CodeMapGenerator.debugLogging {
                print("\n🍎 [Phase 2.5] Swift-specific: Building range-based type boundaries via strategy")
            }
            let swiftToken = CodeMapGenerator.Signpost.begin("codemap.swift_context")
            let swiftContextStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
            swiftContext = SwiftCodeMapStrategy.buildContext(
                index: captureIndex,
                content: content,
                boundaries: boundaries,
                performanceCollector: activePerfStats
            )
            if perfEnabled {
                activePerfStats?.swiftContextDuration += (CFAbsoluteTimeGetCurrent() - swiftContextStart)
            }
            CodeMapGenerator.Signpost.end("codemap.swift_context", swiftToken)

            // Also populate interfaceBoundaries for protocols
            for boundary in swiftContext!.typeBoundaries where boundary.isProtocol {
                interfaceBoundaries[boundary.startLine] = InterfaceInfo(name: boundary.name, properties: [], methods: [])
            }

            if CodeMapGenerator.debugLogging {
                print("   🍎 Built \(swiftContext!.typeBoundaries.count) Swift type boundaries")
            }
        }

        // ------------------------------------------------------------------
        // 2.6) TS/TSX-specific: Build container boundaries (via strategy)
        //      BUG FIX #1: Only for TS/TSX, NOT for JS
        // ------------------------------------------------------------------
        var tsContext: TypeScriptCodeMapStrategy.Context? = nil
        var usesTSRangeContainment = false

        if isTSLike {
            if CodeMapGenerator.debugLogging {
                print("\n📘 [Phase 2.6] TS/TSX-specific: Building range-based container boundaries via strategy")
            }
            let tsToken = CodeMapGenerator.Signpost.begin("codemap.ts_context")
            let tsContextStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
            tsContext = TypeScriptCodeMapStrategy.buildContext(
                index: captureIndex,
                content: content,
                boundaries: boundaries
            )
            if perfEnabled {
                activePerfStats?.tsContextDuration += (CFAbsoluteTimeGetCurrent() - tsContextStart)
            }
            CodeMapGenerator.Signpost.end("codemap.ts_context", tsToken)

            usesTSRangeContainment = TypeScriptCodeMapStrategy.useRangeContainment(tsContext!)

            // Also populate classesByLine and interfaceBoundaries for compatibility
            for boundary in tsContext!.containerBoundaries {
                switch boundary.kind {
                case .class:
                    if classesByLine[boundary.startLine] == nil {
                        classesByLine[boundary.startLine] = ClassInfo(name: boundary.name, methods: [], properties: [])
                    }
                case .interface:
                    if interfaceBoundaries[boundary.startLine] == nil {
                        interfaceBoundaries[boundary.startLine] = InterfaceInfo(name: boundary.name, properties: [], methods: [])
                    }
                }
            }

            if CodeMapGenerator.debugLogging {
                print("   📘 Built \(tsContext!.containerBoundaries.count) TS container boundaries")
                print("   📘 usesTSRangeContainment: \(usesTSRangeContainment)")
            }
        }

        self.content = content
        self.supportedLanguage = supportedLanguage
        self.terminator = terminator
        self.isLightweightLang = isLightweightLang
        self.isTSLike = isTSLike
        self.isJSLike = isJSLike
        self.isJSTS = isJSTS
        self.nsContent = nsContent
        self.boundaries = boundaries
        self.contentLength = contentLength
        self.lineCache = lineCache
        self.extractionMemo = extractionMemo
        self.activePerfOptions = activePerfOptions
        self.activePerfStats = activePerfStats
        self.perfEnabled = perfEnabled
        self.perfCollectCounters = perfCollectCounters
        self.captureIndex = captureIndex
        self.sortedCaps = sortedCaps
        self.imports = imports
        self.exports = exports
        self.enums = enums
        self.aliases = aliases
        self.literalUnions = literalUnions
        self.macros = macros
        self.referencedTypes = referencedTypes
        self.globalFunctions = globalFunctions
        self.globalVariables = globalVariables
        self.classesByLine = classesByLine
        self.interfaceBoundaries = interfaceBoundaries
        self.processedVarLines = processedVarLines
        self.processedMultiVarKeys = processedMultiVarKeys
        self.processedFunctionLines = processedFunctionLines
        self.currentEnum = currentEnum
        self.seenImportExport = seenImportExport
        self.classBoundaries = classBoundaries
        self.usesRangeContainmentForClasses = usesRangeContainmentForClasses
        self.pythonEnumDeclsByRange = pythonEnumDeclsByRange
        self.interfaceBoundaryList = interfaceBoundaryList
        self.usesRangeContainmentForInterfaces = usesRangeContainmentForInterfaces
        self.rustStructNames = rustStructNames
        self.classBoundariesByRange = classBoundariesByRange
        self.interfaceBoundaryListByRange = interfaceBoundaryListByRange
        self.rustImplBoundariesByRange = rustImplBoundariesByRange
        self.swiftContext = swiftContext
        self.tsContext = tsContext
        self.usesTSRangeContainment = usesTSRangeContainment
    }

    func pythonEnumName(containing range: NSRange) -> String? {
        let endIdx = CodeMapGenerator.binarySearchFirstFalse(count: pythonEnumDeclsByRange.count) { idx in
            pythonEnumDeclsByRange[idx].range.location <= range.location
        }
        guard endIdx > 0 else { return nil }

        var best: (range: NSRange, name: String)? = nil
        for i in stride(from: endIdx - 1, through: 0, by: -1) {
            let decl = pythonEnumDeclsByRange[i]
            if CodeMapGenerator.rangeContains(decl.range, range), best == nil || CodeMapGenerator.isBetterRange(decl.range, than: best!.range) {
                best = decl
            }
        }
        return best?.name
    }
    func enclosingBoundary(for range: NSRange, line: Int) -> ClassBoundary? {
        if usesRangeContainmentForClasses {
            let endIdx = CodeMapGenerator.binarySearchFirstFalse(count: classBoundariesByRange.count) { idx in
                (classBoundariesByRange[idx].range?.location ?? Int.max) <= range.location
            }
            guard endIdx > 0 else { return nil }

            var best: ClassBoundary? = nil
            for i in stride(from: endIdx - 1, through: 0, by: -1) {
                let b = classBoundariesByRange[i]
                guard let bRange = b.range else { continue }
                if CodeMapGenerator.rangeContains(bRange, range), best == nil || CodeMapGenerator.isBetterRange(bRange, than: best!.range!) {
                    best = b
                }
            }
            return best
        }
        let idx = CodeMapGenerator.binarySearchFirstFalse(count: classBoundaries.count) { classBoundaries[$0].startLine <= line }
        return idx > 0 ? classBoundaries[idx - 1] : nil
    }

    func enclosingInterface(for range: NSRange, line: Int) -> InterfaceBoundary? {
        if usesRangeContainmentForInterfaces {
            let endIdx = CodeMapGenerator.binarySearchFirstFalse(count: interfaceBoundaryListByRange.count) { idx in
                (interfaceBoundaryListByRange[idx].range?.location ?? Int.max) <= range.location
            }
            guard endIdx > 0 else { return nil }

            var best: InterfaceBoundary? = nil
            for i in stride(from: endIdx - 1, through: 0, by: -1) {
                let b = interfaceBoundaryListByRange[i]
                guard let bRange = b.range else { continue }
                if CodeMapGenerator.rangeContains(bRange, range), best == nil || CodeMapGenerator.isBetterRange(bRange, than: best!.range!) {
                    best = b
                }
            }
            return best
        }
        // Only return an interface if we're within a very close range
        // TypeScript interfaces are typically compact
        let idx = CodeMapGenerator.binarySearchFirstFalse(count: interfaceBoundaryList.count) { interfaceBoundaryList[$0].startLine <= line }
        let candidate: InterfaceBoundary?
        if idx > 0 {
            let b = interfaceBoundaryList[idx - 1]
            candidate = (line - b.startLine <= 30) ? b : nil
        } else {
            candidate = nil
        }
        if CodeMapGenerator.debugLogging, let c = candidate {
            print("   🔍 Line \(line) might be in interface '\(c.name)' starting at line \(c.startLine)")
        }
        return candidate
    }

    func enclosingRustImplBoundary(for range: NSRange) -> RustImplBoundary? {
        let endIdx = CodeMapGenerator.binarySearchFirstFalse(count: rustImplBoundariesByRange.count) { idx in
            rustImplBoundariesByRange[idx].range.location <= range.location
        }
        guard endIdx > 0 else { return nil }

        var best: RustImplBoundary? = nil
        for i in stride(from: endIdx - 1, through: 0, by: -1) {
            let b = rustImplBoundariesByRange[i]
            if CodeMapGenerator.rangeContains(b.range, range), best == nil || CodeMapGenerator.isBetterRange(b.range, than: best!.range) {
                best = b
            }
        }
        return best
    }

    func classKey(forTypeName name: String) -> Int? {
        classesByLine.first(where: { $0.value.name == name })?.key
    }

    func simpleIdentifier(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        return CodeMapGenerator.firstRegexGroup(CodeMapGenerator.RegexCache.simpleIdentifier, in: trimmed)
    }

    func goReceiverType(from decl: String) -> String? {
        if let receiver = CodeMapGenerator.firstRegexGroup(CodeMapGenerator.RegexCache.goReceiverType, in: decl) {
            let tokens = receiver.split(whereSeparator: { $0.isWhitespace })
            guard let last = tokens.last else { return nil }
            var typeToken = String(last).trimmingCharacters(in: .whitespacesAndNewlines)
            typeToken = typeToken.trimmingCharacters(in: CharacterSet(charactersIn: "*"))
            if let bracket = typeToken.firstIndex(of: "[") {
                typeToken = String(typeToken[..<bracket])
            }
            if let dot = typeToken.split(separator: ".").last {
                typeToken = String(dot)
            }
            return typeToken.isEmpty ? nil : typeToken
        }
        return nil
    }

    // ------------------------------------------------------------------
    // Capture declaration helper for strategies
    // ------------------------------------------------------------------
    func captureDecl(_ range: NSRange, _ term: Character) -> String {
        CodeMapGenerator.captureDeclaration(
            nsContent: nsContent,
            for: range,
            lineRange: lineCache.range(covering: range),
            terminator: term,
            jsTsContext: nil,
            perfStats: activePerfStats,
            perfOptions: activePerfOptions
        )
    }

    func recordCaptureAttribution(_ category: CodeMapGenerator.CaptureLoopAttributionCategory, since start: CFAbsoluteTime) {
        guard perfEnabled else { return }
        CodeMapGenerator.recordCaptureLoopAttribution(
            category: category,
            duration: CFAbsoluteTimeGetCurrent() - start,
            collectCounters: perfCollectCounters,
            perfStats: activePerfStats
        )
    }
    func recordFallbackFunctionAttribution(_ category: CodeMapGenerator.FallbackFunctionAttributionCategory, since start: CFAbsoluteTime) {
        guard perfEnabled else { return }
        CodeMapGenerator.recordFallbackFunctionAttribution(
            category: category,
            duration: CFAbsoluteTimeGetCurrent() - start,
            collectCounters: perfCollectCounters,
            perfStats: activePerfStats
        )
    }
}
