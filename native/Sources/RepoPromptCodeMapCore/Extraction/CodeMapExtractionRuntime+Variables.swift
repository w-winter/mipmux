// Modified for smip: extraction state and capture handlers separated.
import Foundation
import CoreFoundation
import SwiftTreeSitter

extension CodeMapExtractionRuntime {
    func handleVariableCapture(_ cap: CodeMapIndexedCapture, lineNo: Int, attributionStart: CFAbsoluteTime) {
        // Skip legacy variable captures for Swift - we use SwiftCodeMapStrategy
        if supportedLanguage == .swift {
            recordCaptureAttribution(.variable, since: attributionStart)
            return
        }

        // Python: route Enum members to enum cases
        if supportedLanguage == .python, let enumName = pythonEnumName(containing: cap.range) {
            let rawName = CodeMapGenerator.substring(content: content, range: cap.range)
            if CodeMapGenerator.RegexCache.upperSnakeCase.wholeMatch(in: rawName) {
                if currentEnum?.name != enumName {
                    if let e = currentEnum {
                        enums.append(e)
                    }
                    currentEnum = EnumInfo(name: enumName, cases: [])
                }
                if currentEnum != nil, !currentEnum!.cases.contains(rawName) {
                    currentEnum!.cases.append(rawName)
                }
                recordCaptureAttribution(.variable, since: attributionStart)
                return
            }
        }

        // Skip for TS/TSX if using range containment and it's a field
        if isTSLike && usesTSRangeContainment && cap.name == "variable.field" {
            recordCaptureAttribution(.variable, since: attributionStart)
            return
        }

        // Check if this variable is on the same line as a function (arrow function)
        let lnRange = lineCache.range(for: cap.range.location)
        let capturedText = CodeMapGenerator.substring(content: content, range: cap.range)
        let simpleName = simpleIdentifier(from: capturedText)
        if processedFunctionLines.contains(lnRange.location) {
            if CodeMapGenerator.debugLogging {
                print("   ⏭️  Skipped variable on function line (likely arrow function)")
            }
            recordCaptureAttribution(.variable, since: attributionStart)
            return
        }

        // 🔧 Fix 1: Capture the raw line first, keep its indent, and only then trim when we store it
        let rawLine = lineCache.line(for: cap.range.location) // keep spaces
        let trimmedLine = rawLine.trimmingCharacters(in: CharacterSet.whitespaces)

        // Use rawLine for indent detection
        let indent = rawLine.prefix { $0.isWhitespace }.count
        if supportedLanguage == .ts, indent > 0 { // interface / type-literal
            if CodeMapGenerator.debugLogging { print("   ⏭️  Skipped interface member") }
            recordCaptureAttribution(.variable, since: attributionStart)
            return
        }

        // Now get the full declaration for storage (but use rawLine for indent detection above)
        let rawDecl = CodeMapGenerator.captureDeclaration(
            nsContent: nsContent,
            for: cap.range,
            lineRange: lineCache.range(covering: cap.range),
            terminator: terminator,
            jsTsContext: nil,
            returnRawJSTS: isJSTS,
            perfStats: activePerfStats,
            perfOptions: activePerfOptions
        )
        let fullDecl: String
        if isJSTS {
            let context = CodeMapGenerator.jstsContextForVariableDecl(rawDecl)
            var extracted = extractionMemo.jstsSignature(
                from: rawDecl,
                context: context,
                perfStats: activePerfStats,
                perfOptions: activePerfOptions
            )
            if context == .statementLike {
                extracted = JSTSSignatureExtractor.extractVariableSignature(from: extracted)
            }
            fullDecl = extracted
        } else {
            fullDecl = rawDecl
        }

        // Fix 2: Ignore lines that are obviously continuations
        let trimmed = fullDecl.trimmingCharacters(in: .whitespacesAndNewlines)

        // 🔧 Fix 2: Guard against type-alias lines that sneak in
        if supportedLanguage == .ts, trimmedLine.contains("="),
           trimmedLine.hasSuffix(";"), !trimmedLine.contains(":")
        {
            if CodeMapGenerator.debugLogging { print("   ⏭️  Skipped type-alias masquerading as variable") }
            recordCaptureAttribution(.variable, since: attributionStart)
            return
        }

        // ⛔ 2) Skip lines that start with "type " – they're aliases already captured
        if trimmed.hasPrefix("type ") {
            if CodeMapGenerator.debugLogging {
                print("   ⏭️  Skipped type-alias in variable capture: '\(trimmed)'")
            }
            recordCaptureAttribution(.variable, since: attributionStart)
            return
        }

        // ⛔ 3) Skip union/intersection continuation lines ("… |" / "… &")
        if trimmed.hasPrefix("|") || trimmed.hasPrefix("&") {
            if CodeMapGenerator.debugLogging {
                print("   ⏭️  Skipped union/intersection fragment: '\(trimmed)'")
            }
            recordCaptureAttribution(.variable, since: attributionStart)
            return
        }

        let junk = [":", ","]
        if junk.contains(trimmed) {
            if CodeMapGenerator.debugLogging {
                print("   ⏭️  Skipped continuation line: '\(trimmed)'")
            }
            recordCaptureAttribution(.variable, since: attributionStart)
            return
        }

        // Fix 6: Filter empty / whitespace artifacts
        if trimmed.isEmpty {
            if CodeMapGenerator.debugLogging {
                print("   ⏭️  Skipped empty artifact")
            }
            recordCaptureAttribution(.variable, since: attributionStart)
            return
        }

        if CodeMapGenerator.debugLogging {
            print("   🏷️  Variable/field declaration: '\(fullDecl.prefix(100))\(fullDecl.count > 100 ? "..." : "")'")
        }

        if isLightweightLang {
            let variableName: String
            if supportedLanguage == .ruby {
                let trimmedCaptured = capturedText.trimmingCharacters(in: .whitespacesAndNewlines)
                variableName = trimmedCaptured.isEmpty ? (simpleName ?? fullDecl) : trimmedCaptured
            } else if isJSTS, cap.name == "variable.global" {
                variableName = CodeMapGenerator.extractJSTSVariableName(from: trimmedLine)
                    ?? CodeMapGenerator.extractJSTSVariableName(from: fullDecl)
                    ?? simpleName
                    ?? fullDecl
            } else {
                variableName = simpleName ?? fullDecl
            }
            var typeName: String? = nil
            if isTSLike, let match = extractionMemo.matchVariableLine(fullDecl, language: supportedLanguage, stats: activePerfStats),
               let vType = match["type"], !vType.isEmpty
            {
                typeName = vType
                referencedTypes.insert(rawType: vType)
            }
            let info = VariableInfo(name: variableName, typeName: typeName, definitionLine: fullDecl)

            let ifaceBoundary = (!isTSLike && supportedLanguage != .swift)
                ? enclosingInterface(for: cap.range, line: lineNo)
                : nil
            if let iface = ifaceBoundary {
                interfaceBoundaries[iface.startLine]?.properties.append(
                    PropertyInfo(name: info.name, typeName: info.typeName)
                )
                if CodeMapGenerator.debugLogging {
                    print("   ⚡️ Added interface property '\(fullDecl)' to '\(iface.name)'")
                }
                recordCaptureAttribution(.variable, since: attributionStart)
                return
            }

            // Special handling for JS/TS
            if isJSTS {
                // Generator-side fallback: detect HOC wrappers and Object.assign
                // that should be functions, not globalVars
                let isFunctionValued = trimmedLine.contains("= forwardRef") ||
                    trimmedLine.contains("= memo(") ||
                    trimmedLine.contains("= React.forwardRef") ||
                    trimmedLine.contains("= React.memo(") ||
                    trimmedLine.contains("= Object.assign(")

                if isFunctionValued, cap.name == "variable.global" {
                    // Extract the variable name from the declaration
                    // Pattern: (export )?(const|let|var) Name = ...
                    let fnName: String = if let match = CodeMapGenerator.firstRegexGroup(CodeMapGenerator.RegexCache.jstsVarNameExtract, in: trimmedLine) {
                        match
                    } else {
                        fullDecl
                    }

                    let fnLine = lineNo
                    let fnInfo = FunctionInfo(
                        name: fnName,
                        parameters: [],
                        returnType: nil,
                        definitionLine: fullDecl,
                        lineNumber: fnLine
                    )
                    if !globalFunctions.contains(where: { $0.definitionLine == fullDecl }) {
                        globalFunctions.append(fnInfo)
                        if CodeMapGenerator.debugLogging {
                            print("   ⚡️ JS/TS: Reclassified HOC/Object.assign '\(fnName)' as function")
                        }
                    }
                    recordCaptureAttribution(.variable, since: attributionStart)
                    return
                }

                // For JS/TS, only add to class if it's a field (variable.field capture)
                if cap.name == "variable.field" {
                    if let bound = enclosingBoundary(for: cap.range, line: lineNo) {
                        classesByLine[bound.startLine]?.properties.append(
                            PropertyInfo(name: info.name, typeName: info.typeName)
                        )
                        if CodeMapGenerator.debugLogging {
                            print("   ⚡️ JS/TS: Added field '\(fullDecl)' to class '\(bound.name)'")
                        }
                    }
                } else {
                    // All other variables are global
                    globalVariables.append(info)
                    if CodeMapGenerator.debugLogging {
                        print("   ⚡️ JS/TS: Added global variable '\(fullDecl)'")
                    }
                }
            } else {
                // Original logic for other languages
                if let bound = enclosingBoundary(for: cap.range, line: lineNo) {
                    classesByLine[bound.startLine]?.properties.append(
                        PropertyInfo(name: info.name, typeName: nil)
                    )
                    if CodeMapGenerator.debugLogging {
                        print("   ⚡️ Lightweight: Added property '\(fullDecl)' to class '\(bound.name)'")
                    }
                } else {
                    globalVariables.append(info)
                    if CodeMapGenerator.debugLogging {
                        print("   ⚡️ Lightweight: Added global variable '\(fullDecl)'")
                    }
                }
            }
            recordCaptureAttribution(.variable, since: attributionStart)
            return
        }

        if supportedLanguage == .go || supportedLanguage == .c {
            let keyName = capturedText.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = "\(lnRange.location):\(keyName)"
            if processedMultiVarKeys.contains(key) {
                if CodeMapGenerator.debugLogging {
                    print("   ⏭️  Skipped already processed variable: '\(keyName)'")
                }
                recordCaptureAttribution(.variable, since: attributionStart)
                return
            }
            processedMultiVarKeys.insert(key)
        } else {
            if processedVarLines.contains(lnRange.location) {
                if CodeMapGenerator.debugLogging {
                    print("   ⏭️  Skipped already processed variable line")
                }
                recordCaptureAttribution(.variable, since: attributionStart)
                return
            }
            processedVarLines.insert(lnRange.location)
        }

        var matchedName: String? = nil
        if let match = extractionMemo.matchVariableLine(fullDecl, language: supportedLanguage, stats: activePerfStats) {
            matchedName = match["name"]
            if let vType = match["type"] {
                referencedTypes.insert(rawType: vType)
                if CodeMapGenerator.debugLogging {
                    print("   🔍 Heavyweight parsing extracted type: '\(vType)'")
                }
            }
        } else if CodeMapGenerator.debugLogging {
            print("   ⚠️  Heavyweight variable regex parsing failed for: '\(fullDecl)'")
        }

        let variableName: String = if isJSTS, cap.name == "variable.global" {
            CodeMapGenerator.extractJSTSVariableName(from: trimmedLine)
                ?? CodeMapGenerator.extractJSTSVariableName(from: fullDecl)
                ?? simpleName
                ?? matchedName
                ?? fullDecl
        } else if supportedLanguage == .go {
            CodeMapGenerator.extractGoVariableName(captureText: capturedText, decl: fullDecl)
                ?? matchedName
                ?? simpleName
                ?? fullDecl
        } else if supportedLanguage == .c {
            CodeMapGenerator.extractCVariableName(captureText: capturedText, decl: fullDecl)
                ?? matchedName
                ?? simpleName
                ?? fullDecl
        } else {
            matchedName ?? simpleName ?? fullDecl
        }
        let varInfo = VariableInfo(name: variableName, typeName: "", definitionLine: fullDecl)
        let ifaceBoundary = (!isTSLike && supportedLanguage != .swift)
            ? enclosingInterface(for: cap.range, line: lineNo)
            : nil
        if let iface = ifaceBoundary {
            interfaceBoundaries[iface.startLine]?.properties.append(
                PropertyInfo(name: varInfo.name, typeName: varInfo.typeName)
            )
            if CodeMapGenerator.debugLogging {
                print("   ✅ Added interface property '\(varInfo.name)' to '\(iface.name)'")
            }
            recordCaptureAttribution(.variable, since: attributionStart)
            return
        }

        // Special handling for JS/TS (heavyweight path)
        if isJSTS {
            // For JS/TS, only add to class if it's a field (variable.field capture)
            if cap.name == "variable.field" {
                if let bound = enclosingBoundary(for: cap.range, line: lineNo) {
                    classesByLine[bound.startLine]?.properties.append(
                        PropertyInfo(name: varInfo.name, typeName: varInfo.typeName)
                    )
                    if CodeMapGenerator.debugLogging {
                        print("   ✅ JS/TS: Added field '\(varInfo.name)' to class '\(bound.name)'")
                    }
                }
            } else {
                // All other variables are global
                globalVariables.append(varInfo)
                if CodeMapGenerator.debugLogging {
                    print("   ✅ JS/TS: Added global variable '\(varInfo.name)'")
                }
            }
        } else {
            // Original logic for other languages
            if let bound = enclosingBoundary(for: cap.range, line: lineNo) {
                classesByLine[bound.startLine]?.properties.append(
                    PropertyInfo(name: varInfo.name, typeName: varInfo.typeName)
                )
                if CodeMapGenerator.debugLogging {
                    print("   ✅ Added property '\(varInfo.name)' to class '\(bound.name)'")
                }
            } else {
                globalVariables.append(varInfo)
                if CodeMapGenerator.debugLogging {
                    print("   ✅ Added global variable '\(varInfo.name)'")
                }
            }
        }
        recordCaptureAttribution(.variable, since: attributionStart)
    }
}
