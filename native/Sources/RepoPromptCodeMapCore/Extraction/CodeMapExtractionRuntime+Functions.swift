// Modified for mipmux: extraction state and capture handlers separated.
import Foundation
import CoreFoundation
import SwiftTreeSitter

extension CodeMapExtractionRuntime {
    func handleFunctionCapture(_ cap: CodeMapIndexedCapture, lineNo: Int, attributionStart: CFAbsoluteTime) {
        // Skip legacy function captures for Swift - we use SwiftCodeMapStrategy
        if supportedLanguage == .swift {
            recordFallbackFunctionAttribution(.skipped, since: attributionStart)
            recordCaptureAttribution(.function, since: attributionStart)
            return
        }

        // Track this line as processed for functions
        let lnRange = lineCache.range(for: cap.range.location)
        processedFunctionLines.insert(lnRange.location)

        // For TS/TSX arrow functions, the capture is on the identifier - use it as the name
        // For other function types, the capture may be on a larger node
        let capturedText = CodeMapGenerator.substring(content: content, range: cap.range)
        let rawDecl: String
        let declarationStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
        if isJSTS {
            rawDecl = CodeMapGenerator.captureDeclaration(
                nsContent: nsContent,
                for: cap.range,
                lineRange: lineCache.range(covering: cap.range),
                terminator: terminator,
                jsTsContext: .functionLike,
                returnRawJSTS: true,
                perfStats: activePerfStats,
                perfOptions: activePerfOptions
            )
        } else {
            rawDecl = CodeMapGenerator.captureDeclaration(
                nsContent: nsContent,
                for: cap.range,
                lineRange: lineCache.range(covering: cap.range),
                terminator: terminator,
                jsTsContext: nil,
                perfStats: activePerfStats,
                perfOptions: activePerfOptions
            )
        }
        recordFallbackFunctionAttribution(.declaration, since: declarationStart)
        // BUG FIX #4: Use functionLike context for function declarations
        var decl: String
        if isJSTS {
            let jstsSignatureStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
            decl = extractionMemo.jstsSignature(
                from: rawDecl,
                context: .functionLike,
                perfStats: activePerfStats,
                perfOptions: activePerfOptions
            )
            recordFallbackFunctionAttribution(.jstsSignature, since: jstsSignatureStart)
            let trimmedDecl = decl.trimmingCharacters(in: .whitespacesAndNewlines)
            let tsFastPathStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
            if trimmedDecl.hasSuffix(":"),
               let rt = extractionMemo.tsReturnType(from: rawDecl, stats: activePerfStats),
               !rt.isEmpty
            {
                decl = trimmedDecl + " " + rt
            }
            recordFallbackFunctionAttribution(.tsFastPath, since: tsFastPathStart)
        } else {
            decl = rawDecl
        }

        if CodeMapGenerator.debugLogging {
            print("   🔧 Function/method declaration: '\(decl.prefix(150))\(decl.count > 150 ? "..." : "")'")
            print("   📝 Captured text: '\(capturedText)'")
        }

        // ⚡️ Fast path for lightweight languages: no heavy regex
        if isLightweightLang {
            if perfCollectCounters {
                activePerfStats?.fallbackFunctionLightweightCount += 1
            }
            let rawLine = lineCache.line(for: cap.range.location)
            // For TS/TSX, extract a clean function name using robust regex
            let nameExtractionStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
            var fnName: String
            if isJSTS {
                fnName = CodeMapGenerator.extractJSTSFunctionName(captureText: capturedText, decl: decl)
            } else {
                let trimmedCaptured = capturedText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmedCaptured.isEmpty,
                   !CodeMapGenerator.containsWhitespace(trimmedCaptured)
                {
                    fnName = trimmedCaptured
                } else {
                    fnName = decl
                }
            }
            recordFallbackFunctionAttribution(.nameExtraction, since: nameExtractionStart)

            var returnType: String? = nil
            var params: [ParameterInfo] = []

            let lightweightMatch: [String: String]?
            if isTSLike {
                let lteParseStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
                lightweightMatch = extractionMemo.matchFunctionLine(decl, language: supportedLanguage, stats: activePerfStats)
                recordFallbackFunctionAttribution(.lteParse, since: lteParseStart)
            } else {
                lightweightMatch = nil
            }
            if let match = lightweightMatch {
                if let n = match["name"], !n.isEmpty { fnName = n }
                if let rt = match["returnType"], !rt.isEmpty {
                    returnType = rt
                    let refsStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
                    referencedTypes.insert(rawType: rt)
                    recordFallbackFunctionAttribution(.referencedTypes, since: refsStart)
                }
                if let pt = match["parameterTypes"], !pt.isEmpty {
                    let types = pt
                        .split(separator: ",")
                        .map { $0.trimmingCharacters(in: .whitespaces) }
                    params = types.enumerated().map {
                        ParameterInfo(
                            externalName: nil,
                            localName: "param\($0.offset)",
                            typeName: $0.element
                        )
                    }
                    let refsStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
                    referencedTypes.insertMany(rawTypes: types)
                    recordFallbackFunctionAttribution(.referencedTypes, since: refsStart)
                }
            }
            if isTSLike, returnType == nil {
                let tsFastPathStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
                let rawMatch = extractionMemo.matchFunctionLineParsed(rawLine, language: supportedLanguage, stats: activePerfStats)
                recordFallbackFunctionAttribution(.tsFastPath, since: tsFastPathStart)
                if let rawMatch, let rt = rawMatch.returnType, !rt.isEmpty {
                    returnType = rt
                    let refsStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
                    referencedTypes.insert(rawType: rt)
                    recordFallbackFunctionAttribution(.referencedTypes, since: refsStart)
                }
            }
            if isTSLike {
                let tsFastPathStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
                let varMatch = extractionMemo.matchVariableLine(rawDecl, language: supportedLanguage, stats: activePerfStats)
                recordFallbackFunctionAttribution(.tsFastPath, since: tsFastPathStart)
                if let varMatch,
                   let vType = varMatch["type"], !vType.isEmpty
                {
                    if returnType == nil {
                        returnType = vType
                    }
                    let refsStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
                    referencedTypes.insert(rawType: vType)
                    recordFallbackFunctionAttribution(.referencedTypes, since: refsStart)
                }
            }

            let modelInsertionStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
            let fnLine = lineNo
            let fnInfo = FunctionInfo(
                name: fnName,
                parameters: params,
                returnType: returnType,
                definitionLine: decl,
                lineNumber: fnLine
            )
            let routingStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
            let ifaceBoundary = (!isTSLike && supportedLanguage != .swift)
                ? enclosingInterface(for: cap.range, line: lineNo)
                : nil
            recordFallbackFunctionAttribution(.routing, since: routingStart)
            if let iface = ifaceBoundary {
                if !interfaceBoundaries[iface.startLine]!.methods.contains(where: { $0.definitionLine == decl }) {
                    interfaceBoundaries[iface.startLine]?.methods.append(fnInfo)
                    if perfCollectCounters {
                        activePerfStats?.fallbackFunctionInterfaceInsertCount += 1
                    }
                }
                if CodeMapGenerator.debugLogging {
                    print("   ⚡️ Added interface method '\(decl)' to '\(iface.name)'")
                }
                recordFallbackFunctionAttribution(.modelInsertion, since: modelInsertionStart)
                recordCaptureAttribution(.function, since: attributionStart)
                return
            }

            // For JS/TS, only add to class if it's actually a method (not just any function after a class)
            if isJSTS, cap.name == "method" {
                // This is definitely a class method
                let routingStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
                let boundary = enclosingBoundary(for: cap.range, line: lineNo)
                recordFallbackFunctionAttribution(.routing, since: routingStart)
                if let boundary {
                    if !classesByLine[boundary.startLine]!.methods.contains(where: { $0.definitionLine == decl }) {
                        classesByLine[boundary.startLine]?.methods.append(fnInfo)
                        if perfCollectCounters {
                            activePerfStats?.fallbackFunctionMethodInsertCount += 1
                        }
                        if CodeMapGenerator.debugLogging {
                            print("   ⚡️ JS/TS: Added method '\(decl)' to class '\(boundary.name)'")
                        }
                    }
                }
            } else if isJSTS {
                // For JS/TS, all non-method functions are global
                if !globalFunctions.contains(where: { $0.definitionLine == decl }) {
                    globalFunctions.append(fnInfo)
                    if perfCollectCounters {
                        activePerfStats?.fallbackFunctionGlobalInsertCount += 1
                    }
                    if CodeMapGenerator.debugLogging {
                        print("   ⚡️ JS/TS: Added global function '\(decl)'")
                    }
                }
            } else {
                // Original logic for other languages
                let routingStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
                let boundary = enclosingBoundary(for: cap.range, line: lineNo)
                recordFallbackFunctionAttribution(.routing, since: routingStart)
                if let boundary {
                    if !classesByLine[boundary.startLine]!.methods.contains(where: { $0.definitionLine == decl }) {
                        classesByLine[boundary.startLine]?.methods.append(fnInfo)
                        if perfCollectCounters {
                            activePerfStats?.fallbackFunctionMethodInsertCount += 1
                        }
                        if CodeMapGenerator.debugLogging {
                            print("   ⚡️ Lightweight: Added method '\(decl)' to class '\(boundary.name)'")
                        }
                    } else if CodeMapGenerator.debugLogging {
                        print("   ⏭️  Lightweight: Skipped duplicate method: '\(decl)'")
                    }
                } else {
                    if !globalFunctions.contains(where: { $0.definitionLine == decl }) {
                        globalFunctions.append(fnInfo)
                        if perfCollectCounters {
                            activePerfStats?.fallbackFunctionGlobalInsertCount += 1
                        }
                        if CodeMapGenerator.debugLogging {
                            print("   ⚡️ Lightweight: Added global function '\(decl)'")
                        }
                    } else if CodeMapGenerator.debugLogging {
                        print("   ⏭️  Lightweight: Skipped duplicate global function: '\(decl)'")
                    }
                }
            }
            recordFallbackFunctionAttribution(.modelInsertion, since: modelInsertionStart)
            recordCaptureAttribution(.function, since: attributionStart)
            return
        }

        // Heavyweight parsing with regex extractor
        if perfCollectCounters {
            activePerfStats?.fallbackFunctionHeavyweightCount += 1
        }
        var fnName = decl
        var returnType: String? = nil
        var paramTypes: [String] = []

        let lteParseStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
        let heavyweightMatch = extractionMemo.matchFunctionLine(decl, language: supportedLanguage, stats: activePerfStats)
        recordFallbackFunctionAttribution(.lteParse, since: lteParseStart)
        if let match = heavyweightMatch {
            if let n = match["name"], !n.isEmpty { fnName = n }
            if let rt = match["returnType"], !rt.isEmpty {
                returnType = rt
                let refsStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
                referencedTypes.insert(rawType: rt)
                recordFallbackFunctionAttribution(.referencedTypes, since: refsStart)
            }
            if let pt = match["parameterTypes"], !pt.isEmpty {
                let types = pt
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                paramTypes.append(contentsOf: types)
                let refsStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
                referencedTypes.insertMany(rawTypes: types)
                recordFallbackFunctionAttribution(.referencedTypes, since: refsStart)
            }
            if CodeMapGenerator.debugLogging {
                print("   🔍 Heavyweight parsing extracted:")
                print("      • Function name: '\(fnName)'")
                print("      • Return type: '\(returnType ?? "none")'")
                print("      • Parameter types: \(paramTypes)")
            }
        } else if CodeMapGenerator.debugLogging {
            print("   ⚠️  Heavyweight regex parsing failed for: '\(decl)'")
        }

        let nameExtractionStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
        if fnName == decl {
            let trimmedCaptured = capturedText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedCaptured.isEmpty,
               !CodeMapGenerator.containsWhitespace(trimmedCaptured)
            {
                fnName = trimmedCaptured
            }
        }
        recordFallbackFunctionAttribution(.nameExtraction, since: nameExtractionStart)

        let modelInsertionStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
        let params = paramTypes.enumerated().map {
            ParameterInfo(
                externalName: nil,
                localName: "param\($0.offset)",
                typeName: $0.element
            )
        }
        let fnLine = lineNo
        let fnInfo = FunctionInfo(
            name: fnName,
            parameters: params,
            returnType: returnType,
            definitionLine: decl,
            lineNumber: fnLine
        )
        let goRoutingStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
        let goReceiver = supportedLanguage == .go ? goReceiverType(from: decl) : nil
        recordFallbackFunctionAttribution(.routing, since: goRoutingStart)
        if supportedLanguage == .go, let receiverType = goReceiver {
            let targetKey = classKey(forTypeName: receiverType) ?? lineNo
            if classesByLine[targetKey] == nil {
                classesByLine[targetKey] = ClassInfo(name: receiverType, methods: [], properties: [])
            }
            if !classesByLine[targetKey]!.methods.contains(where: { $0.definitionLine == decl }) {
                classesByLine[targetKey]?.methods.append(fnInfo)
                if perfCollectCounters {
                    activePerfStats?.fallbackFunctionMethodInsertCount += 1
                }
            }
            recordFallbackFunctionAttribution(.modelInsertion, since: modelInsertionStart)
            recordCaptureAttribution(.function, since: attributionStart)
            return
        }
        let rustRoutingStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
        let rustImplBoundary = supportedLanguage == .rust ? enclosingRustImplBoundary(for: cap.range) : nil
        recordFallbackFunctionAttribution(.routing, since: rustRoutingStart)
        if supportedLanguage == .rust, let implBoundary = rustImplBoundary {
            let targetName = implBoundary.targetTypeName
            if rustStructNames.contains(targetName) {
                let targetKey = classKey(forTypeName: targetName) ?? implBoundary.startLine
                if classesByLine[targetKey] == nil {
                    classesByLine[targetKey] = ClassInfo(name: targetName, methods: [], properties: [])
                }
                if !classesByLine[targetKey]!.methods.contains(where: { $0.definitionLine == decl }) {
                    classesByLine[targetKey]?.methods.append(fnInfo)
                    if perfCollectCounters {
                        activePerfStats?.fallbackFunctionMethodInsertCount += 1
                    }
                }
            }
            recordFallbackFunctionAttribution(.modelInsertion, since: modelInsertionStart)
            recordCaptureAttribution(.function, since: attributionStart)
            return
        }
        let routingStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
        let ifaceBoundary = (!isTSLike && supportedLanguage != .swift)
            ? enclosingInterface(for: cap.range, line: lineNo)
            : nil
        recordFallbackFunctionAttribution(.routing, since: routingStart)
        if let iface = ifaceBoundary {
            if !interfaceBoundaries[iface.startLine]!.methods.contains(where: { $0.definitionLine == decl }) {
                interfaceBoundaries[iface.startLine]?.methods.append(fnInfo)
                if perfCollectCounters {
                    activePerfStats?.fallbackFunctionInterfaceInsertCount += 1
                }
            }
            if CodeMapGenerator.debugLogging {
                print("   ✅ Added interface method '\(fnName)' to '\(iface.name)'")
            }
            recordFallbackFunctionAttribution(.modelInsertion, since: modelInsertionStart)
            recordCaptureAttribution(.function, since: attributionStart)
            return
        }

        // For JS/TS, use capture name to determine if it's a method
        if isJSTS, cap.name == "method" {
            // This is definitely a class method
            let routingStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
            let boundary = enclosingBoundary(for: cap.range, line: lineNo)
            recordFallbackFunctionAttribution(.routing, since: routingStart)
            if let boundary {
                if !classesByLine[boundary.startLine]!.methods.contains(where: { $0.definitionLine == decl }) {
                    classesByLine[boundary.startLine]?.methods.append(fnInfo)
                    if perfCollectCounters {
                        activePerfStats?.fallbackFunctionMethodInsertCount += 1
                    }
                    if CodeMapGenerator.debugLogging {
                        print("   ✅ JS/TS: Added method '\(fnName)' to class '\(boundary.name)'")
                    }
                }
            }
        } else if isJSTS {
            // For JS/TS, all non-method functions are global
            if !globalFunctions.contains(where: { $0.definitionLine == decl }) {
                globalFunctions.append(fnInfo)
                if perfCollectCounters {
                    activePerfStats?.fallbackFunctionGlobalInsertCount += 1
                }
                if CodeMapGenerator.debugLogging {
                    print("   ✅ JS/TS: Added global function '\(fnName)'")
                }
            }
        } else {
            // Original logic for other languages
            let routingStart = perfEnabled ? CFAbsoluteTimeGetCurrent() : 0
            let boundary = enclosingBoundary(for: cap.range, line: lineNo)
            recordFallbackFunctionAttribution(.routing, since: routingStart)
            if let boundary {
                // Fix 4: Strip duplicates caused by overload sets
                if !classesByLine[boundary.startLine]!.methods.contains(where: { $0.definitionLine == decl }) {
                    classesByLine[boundary.startLine]?.methods.append(fnInfo)
                    if perfCollectCounters {
                        activePerfStats?.fallbackFunctionMethodInsertCount += 1
                    }
                    if CodeMapGenerator.debugLogging {
                        print("   ✅ Added method '\(fnName)' to class '\(boundary.name)'")
                    }
                } else if CodeMapGenerator.debugLogging {
                    print("   ⏭️  Skipped duplicate method: '\(decl)'")
                }
            } else {
                // Fix 4: Strip duplicates caused by overload sets
                if !globalFunctions.contains(where: { $0.definitionLine == decl }) {
                    globalFunctions.append(fnInfo)
                    if perfCollectCounters {
                        activePerfStats?.fallbackFunctionGlobalInsertCount += 1
                    }
                    if CodeMapGenerator.debugLogging {
                        print("   ✅ Added global function '\(fnName)'")
                    }
                } else if CodeMapGenerator.debugLogging {
                    print("   ⏭️  Skipped duplicate global function: '\(decl)'")
                }
            }
        }
        recordFallbackFunctionAttribution(.modelInsertion, since: modelInsertionStart)
        recordCaptureAttribution(.function, since: attributionStart)

    }
}
