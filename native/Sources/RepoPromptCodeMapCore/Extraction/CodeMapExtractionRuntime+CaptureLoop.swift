// Modified for smip: extraction state and capture handlers separated.
import Foundation
import CoreFoundation
import SwiftTreeSitter

extension CodeMapExtractionRuntime {
    func run() -> CodeMapGenerator.GenerationOutput {
        // ------------------------------------------------------------------
        // 3)  Main capture loop
        // ------------------------------------------------------------------
        if CodeMapGenerator.debugLogging {
            print("\n🔄 [Phase 3] Processing captures in main loop")
        }

        let loopToken = CodeMapGenerator.Signpost.begin("codemap.capture_loop")
        let loopStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
        var currentLineIndex = 0
        let lineCount = boundaries.count
        for cap in sortedCaps {
            if perfCollectCounters {
                activePerfStats?.capturesProcessed += 1
            }
            var handledByStrategy = false
            let location = cap.range.location
            let lineAdvanceStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
            while currentLineIndex + 1 < lineCount,
                  boundaries[currentLineIndex + 1] <= location
            {
                currentLineIndex += 1
            }
            let lineNo = currentLineIndex + 1
            if perfEnabled {
                CodeMapGenerator.recordCaptureLoopLineAdvance(
                    duration: CFAbsoluteTimeGetCurrent() - lineAdvanceStart,
                    collectCounters: perfCollectCounters,
                    perfStats: activePerfStats
                )
            }
            let attributionStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0

            if CodeMapGenerator.debugLogging {
                let captured = CodeMapGenerator.substring(content: content, range: cap.range)
                print("\n🎯 Processing capture: '\(cap.name)' @ line \(lineNo)")
                print("   📝 Raw captured: '\(captured.prefix(100))\(captured.count > 100 ? "..." : "")'")
            }

            // ------------------------------------------------------------------
            // Swift-specific routing (via strategy)
            // ------------------------------------------------------------------
            if supportedLanguage == .swift, let ctx = swiftContext {
                let handled = SwiftCodeMapStrategy.handleCapture(
                    cap,
                    context: ctx,
                    index: captureIndex,
                    content: content,
                    nsContent: nsContent,
                    boundaries: boundaries,
                    lineNo: lineNo,
                    classesByLine: &classesByLine,
                    interfaceBoundaries: &interfaceBoundaries,
                    globalFunctions: &globalFunctions,
                    globalVariables: &globalVariables,
                    referencedTypes: &referencedTypes,
                    captureDeclaration: captureDecl,
                    perfStats: activePerfStats
                )
                if handled {
                    if CodeMapGenerator.debugLogging {
                        print("   🍎 Handled by SwiftCodeMapStrategy")
                    }
                    if perfCollectCounters {
                        activePerfStats?.swiftStrategyHandled += 1
                    }
                    handledByStrategy = true
                    recordCaptureAttribution(.swiftStrategy, since: attributionStart)
                    continue
                }
            }

            // ------------------------------------------------------------------
            // TS/TSX-specific routing (via strategy)
            // BUG FIX #1: Only route TS/TSX through this, NOT JS
            // ------------------------------------------------------------------
            if isTSLike, let ctx = tsContext,
               usesTSRangeContainment || cap.name == "variable.global"
            {
                let handled = TypeScriptCodeMapStrategy.handleCapture(
                    cap,
                    context: ctx,
                    index: captureIndex,
                    content: content,
                    nsContent: nsContent,
                    boundaries: boundaries,
                    lineNo: lineNo,
                    language: supportedLanguage,
                    getTrimmedLine: { range in
                        lineCache.trimmedLine(covering: range)
                    },
                    classesByLine: &classesByLine,
                    interfaceBoundaries: &interfaceBoundaries,
                    globalFunctions: &globalFunctions,
                    globalVariables: &globalVariables,
                    referencedTypes: &referencedTypes,
                    extractionMemo: &extractionMemo,
                    perfStats: activePerfStats,
                    perfOptions: activePerfOptions
                )
                if handled {
                    if CodeMapGenerator.debugLogging {
                        print("   📘 Handled by TypeScriptCodeMapStrategy")
                    }
                    if perfCollectCounters {
                        activePerfStats?.tsStrategyHandled += 1
                    }
                    handledByStrategy = true
                    recordCaptureAttribution(.tsStrategy, since: attributionStart)
                    continue
                }
            }

            if perfCollectCounters, !handledByStrategy {
                activePerfStats?.fallbackHandled += 1
            }
            // — FIRST, are we sitting inside an interface? ————————————————
            // BUG FIX #2: Gate the line-based heuristic for TS/TSX when using range containment
            if !usesTSRangeContainment, let ifaceBoundary = enclosingInterface(for: cap.range, line: lineNo) {
                // Only process specific captures that are known to be interface members
                switch cap.name {
                case "method_signature", "call_signature":
                    // These are definitely interface method signatures
                    let decl = CodeMapGenerator.captureDeclaration(
                        nsContent: nsContent,
                        for: cap.range,
                        lineRange: lineCache.range(covering: cap.range),
                        terminator: terminator,
                        jsTsContext: nil,
                        perfStats: activePerfStats,
                        perfOptions: activePerfOptions
                    )
                    let fnLine = lineNo
                    interfaceBoundaries[ifaceBoundary.startLine]?.methods.append(
                        FunctionInfo(
                            name: decl,
                            parameters: [],
                            returnType: nil,
                            definitionLine: decl,
                            lineNumber: fnLine
                        )
                    )
                    if CodeMapGenerator.debugLogging {
                        print("   ✅ Added method signature '\(decl)' to interface at line \(ifaceBoundary.startLine)")
                    }
                    recordCaptureAttribution(.interfaceHeuristic, since: attributionStart)
                    continue

                case "property_signature":
                    // These are definitely interface property signatures
                    let decl = CodeMapGenerator.captureDeclaration(
                        nsContent: nsContent,
                        for: cap.range,
                        lineRange: lineCache.range(covering: cap.range),
                        terminator: terminator,
                        jsTsContext: nil,
                        perfStats: activePerfStats,
                        perfOptions: activePerfOptions
                    )
                    interfaceBoundaries[ifaceBoundary.startLine]?.properties.append(
                        PropertyInfo(
                            name: decl,
                            typeName: nil
                        )
                    )
                    if CodeMapGenerator.debugLogging {
                        print("   ✅ Added property signature '\(decl)' to interface at line \(ifaceBoundary.startLine)")
                    }
                    recordCaptureAttribution(.interfaceHeuristic, since: attributionStart)
                    continue

                default:
                    // For other captures, don't assume they're interface members
                    if CodeMapGenerator.debugLogging {
                        print("   🤔 Capture '\(cap.name)' near interface but not a known interface member type")
                    }
                }
            }

            switch cap.name {
            // -------- imports / exports ------------------------------------
            case "import", "import.module", "import.namespace":
                let fullLine = lineCache.trimmedLine(covering: cap.range)
                if !seenImportExport.contains(fullLine) {
                    imports.append(fullLine)
                    seenImportExport.insert(fullLine)
                    if CodeMapGenerator.debugLogging {
                        print("   ✅ Added import: '\(fullLine)'")
                    }
                } else if CodeMapGenerator.debugLogging {
                    print("   ⏭️  Skipped duplicate import: '\(fullLine)'")
                }
                recordCaptureAttribution(.importExport, since: attributionStart)

            case "export", "export.source":
                // Use only the line at cap.range.location to avoid multi-line spans (e.g., "export class Foo { ... }")
                let fullLine = lineCache.trimmedLine(for: cap.range.location)
                if !seenImportExport.contains(fullLine) {
                    exports.append(fullLine)
                    seenImportExport.insert(fullLine)
                    if CodeMapGenerator.debugLogging {
                        print("   ✅ Added export: '\(fullLine)'")
                    }
                } else if CodeMapGenerator.debugLogging {
                    print("   ⏭️  Skipped duplicate export: '\(fullLine)'")
                }
                recordCaptureAttribution(.importExport, since: attributionStart)

            // -------- type‑aliases ----------------------------------------
            case "typeAlias":
                // BUG FIX #4: Use statementLike context for type aliases
                let decl: String
                if isJSTS {
                    let rawDecl = CodeMapGenerator.captureDeclaration(
                        nsContent: nsContent,
                        for: cap.range,
                        lineRange: lineCache.range(covering: cap.range),
                        terminator: terminator,
                        jsTsContext: .statementLike,
                        returnRawJSTS: true,
                        perfStats: activePerfStats,
                        perfOptions: activePerfOptions
                    )
                    decl = extractionMemo.jstsSignature(
                        from: rawDecl,
                        context: .statementLike,
                        perfStats: activePerfStats,
                        perfOptions: activePerfOptions
                    )
                } else {
                    decl = CodeMapGenerator.captureDeclaration(
                        nsContent: nsContent,
                        for: cap.range,
                        lineRange: lineCache.range(covering: cap.range),
                        terminator: terminator,
                        jsTsContext: nil,
                        perfStats: activePerfStats,
                        perfOptions: activePerfOptions
                    )
                }

                // Detect trivial literal‑union alias   (e.g. `'a' | 'b' | 'c'`)
                if decl.contains("'"), decl.contains("|") {
                    literalUnions.append(decl)
                    if CodeMapGenerator.debugLogging {
                        print("   ✅ Added literal union: '\(decl)'")
                    }
                } else {
                    let aliasName = CodeMapGenerator.substring(content: content, range: cap.range)
                    aliases.append(TypeAliasInfo(name: aliasName, definitionLine: decl))
                    if CodeMapGenerator.debugLogging {
                        print("   ✅ Added type alias: '\(aliasName)' -> '\(decl)'")
                    }
                }

                if isTSLike, let rhs = extractionMemo.tsTypeAliasRHS(from: decl, stats: activePerfStats) {
                    activePerfStats?.tsTypeAliasRhsFastPathHits += 1
                    referencedTypes.insert(rawType: rhs)
                }
                recordCaptureAttribution(.typeAlias, since: attributionStart)

            // -------- enums ------------------------------------------------
            case "type.enum":
                if supportedLanguage == .python {
                    recordCaptureAttribution(.enumMacro, since: attributionStart)
                    continue
                }
                let enumName = CodeMapGenerator.substring(content: content, range: cap.range)
                if let e = currentEnum, e.name.isEmpty, !e.cases.isEmpty {
                    currentEnum = EnumInfo(name: enumName, cases: e.cases)
                    if CodeMapGenerator.debugLogging {
                        print("   🏷️  Assigned enum name '\(enumName)' to pending cases (\(e.cases.count))")
                    }
                    recordCaptureAttribution(.enumMacro, since: attributionStart)
                    continue
                }
                if let e = currentEnum {
                    enums.append(e)
                    if CodeMapGenerator.debugLogging {
                        print("   📦 Finalized previous enum: '\(e.name)' with \(e.cases.count) cases")
                    }
                }
                currentEnum = EnumInfo(name: enumName, cases: [])
                if CodeMapGenerator.debugLogging {
                    print("   🆕 Started new enum: '\(enumName)'")
                }
                recordCaptureAttribution(.enumMacro, since: attributionStart)

            case "enum.entry":
                let entry = CodeMapGenerator.substring(content: content, range: cap.range)
                if currentEnum != nil {
                    currentEnum!.cases.append(entry)
                    if CodeMapGenerator.debugLogging {
                        print("   ➕ Added enum case: '\(entry)' to '\(currentEnum?.name ?? "unknown")'")
                    }
                } else {
                    currentEnum = EnumInfo(name: "", cases: [entry])
                    if CodeMapGenerator.debugLogging {
                        print("   🆕 Started anonymous enum with case: '\(entry)'")
                    }
                }
                recordCaptureAttribution(.enumMacro, since: attributionStart)

            // -------- functions / methods (generic, non-Swift) ---------------
            case "function.definition", "function.declaration", "function", "method":
                handleFunctionCapture(cap, lineNo: lineNo, attributionStart: attributionStart)
                continue

            // -------- variables / fields (generic, non-Swift) ----------------
            case "variable.global", "variable.field", "field",
                 "constant.global", "constant":
                handleVariableCapture(cap, lineNo: lineNo, attributionStart: attributionStart)
                continue

            // -------- macros -----------------------------------------------
            case "macro":
                let macroText = CodeMapGenerator.substring(content: content, range: cap.range)
                macros.append(macroText)
                if CodeMapGenerator.debugLogging {
                    print("   ✅ Added macro: '\(macroText)'")
                }
                recordCaptureAttribution(.enumMacro, since: attributionStart)

            default:
                if CodeMapGenerator.debugLogging {
                    print("   ⏭️  Skipped unhandled capture type: '\(cap.name)'")
                }
                recordCaptureAttribution(.skipped, since: attributionStart)
                continue
            }
        }
        if perfEnabled {
            activePerfStats?.captureLoopDuration += (CFAbsoluteTimeGetCurrent() - loopStart)
        }
        CodeMapGenerator.Signpost.end("codemap.capture_loop", loopToken)
        if let e = currentEnum {
            enums.append(e)
            if CodeMapGenerator.debugLogging {
                print("📦 Finalized final enum: '\(e.name)' with \(e.cases.count) cases")
            }
        }

        let typeFinalizeToken = CodeMapGenerator.Signpost.begin("codemap.referenced_types")
        let typeFinalizeStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
        let finalReferences = referencedTypes.finalizeSorted()
        if perfEnabled {
            activePerfStats?.referencedTypesFinalizeDuration += (CFAbsoluteTimeGetCurrent() - typeFinalizeStart)
            activePerfStats?.referencedTypesUniqueCount += finalReferences.count
        }
        CodeMapGenerator.Signpost.end("codemap.referenced_types", typeFinalizeToken)

        return CodeMapGenerator.GenerationOutput(
            imports: imports,
            exports: exports,
            enums: enums,
            aliases: aliases,
            literalUnions: literalUnions,
            macros: macros,
            referencedTypes: finalReferences,
            globalFunctions: globalFunctions,
            globalVariables: globalVariables,
            classesByLine: classesByLine,
            interfacesByLine: interfaceBoundaries
        )
    }
}
