// Modified for mipmux: declarations relocated and cross-file access adjusted.
import Foundation
import CoreFoundation

extension SwiftCodeMapStrategy {
    // MARK: - Swift Signature Extraction

    struct SwiftFunctionSignature {
        let definitionLine: String
        let signatureEnd: Int
    }

    static func normalizeSwiftSignatureWhitespace(
        _ trimmed: String,
        performanceCollector: CodeMapPerformanceCollector?
    ) -> String {
        var needsRewrite = false
        var previousWasWhitespace = false
        var asciiByteCount = 0

        for byte in trimmed.utf8 {
            if byte >= 0x80 {
                let normalized = trimmed.replacing(#/\s+/#, with: " ")
                if let performanceCollector {
                    performanceCollector.swiftSignatureNormalizationUnicodeFallbackCount += 1
                    performanceCollector.swiftSignatureNormalizationInputUTF8ByteCount += trimmed.utf8.count
                    performanceCollector.swiftSignatureNormalizationOutputUTF8ByteCount += normalized.utf8.count
                }
                return normalized
            }

            asciiByteCount += 1
            let isWhitespace = byte == 0x20 || (byte >= 0x09 && byte <= 0x0D)
            if isWhitespace {
                if byte != 0x20 || previousWasWhitespace {
                    needsRewrite = true
                }
                previousWasWhitespace = true
            } else {
                previousWasWhitespace = false
            }
        }

        guard needsRewrite else {
            if let performanceCollector {
                performanceCollector.swiftSignatureNormalizationASCIINoOpCount += 1
                performanceCollector.swiftSignatureNormalizationInputUTF8ByteCount += asciiByteCount
                performanceCollector.swiftSignatureNormalizationOutputUTF8ByteCount += asciiByteCount
            }
            return trimmed
        }

        var normalizedUTF8: [UInt8] = []
        normalizedUTF8.reserveCapacity(asciiByteCount)
        var isCollapsingWhitespace = false
        for byte in trimmed.utf8 {
            let isWhitespace = byte == 0x20 || (byte >= 0x09 && byte <= 0x0D)
            if isWhitespace {
                if !isCollapsingWhitespace {
                    normalizedUTF8.append(0x20)
                    isCollapsingWhitespace = true
                }
            } else {
                normalizedUTF8.append(byte)
                isCollapsingWhitespace = false
            }
        }

        let normalized = String(decoding: normalizedUTF8, as: UTF8.self)
        if let performanceCollector {
            performanceCollector.swiftSignatureNormalizationASCIIRewriteCount += 1
            performanceCollector.swiftSignatureNormalizationInputUTF8ByteCount += asciiByteCount
            performanceCollector.swiftSignatureNormalizationOutputUTF8ByteCount += normalizedUTF8.count
        }
        return normalized
    }

    /// Extracts only the function signature (up to but not including `{`) from a Swift function capture range.
    /// Uses `signatureEndLocation` to correctly handle strings, comments, and nesting.
    static func extractSwiftFunctionSignature(
        from functionRange: NSRange,
        nsContent: NSString,
        boundaries: [Int],
        performanceCollector: CodeMapPerformanceCollector?
    ) -> SwiftFunctionSignature {
        let scanStart = performanceCollector.map { _ in CFAbsoluteTimeGetCurrent() }
        let signatureEnd = signatureEndLocation(
            forFunctionRange: functionRange,
            nsContent: nsContent,
            performanceCollector: performanceCollector
        )
        if let scanStart {
            performanceCollector?.swiftSignatureEndScanDuration +=
                CFAbsoluteTimeGetCurrent() - scanStart
        }
        let signatureLength = signatureEnd - functionRange.location
        let signatureRange = NSRange(location: functionRange.location, length: signatureLength)

        // Get the signature text
        let normalizationStart = performanceCollector.map { _ in CFAbsoluteTimeGetCurrent() }
        let trimmedSignature = nsContent.substring(with: signatureRange)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        // Normalize whitespace (collapse multiple whitespace to single space)
        let signature = normalizeSwiftSignatureWhitespace(
            trimmedSignature,
            performanceCollector: performanceCollector
        )
        if let normalizationStart {
            performanceCollector?.swiftSignatureNormalizationDuration +=
                CFAbsoluteTimeGetCurrent() - normalizationStart
        }

        return SwiftFunctionSignature(definitionLine: signature, signatureEnd: signatureEnd)
    }

    /// Extracts Swift parameters from a function capture range
    static func extractSwiftParameters(
        from functionRange: NSRange,
        signatureEnd: Int,
        context: Context,
        index: CodeMapCaptureIndex,
        nsContent: NSString,
        referencedTypes: inout ReferencedTypesAccumulator,
        performanceCollector: CodeMapPerformanceCollector?
    ) -> [ParameterInfo] {
        var params: [ParameterInfo] = []

        // Collect param nodes within this function
        let paramNodes = index.captures(named: "swift.param.node", containedIn: functionRange)

        for paramNode in paramNodes {
            // Ignore params that appear after the function signature (e.g., nested local functions)
            if paramNode.range.location >= signatureEnd {
                continue
            }
            // Exclude params from nested functions inside this function range
            if let enclosingFn = smallestContainingRange(
                in: context.functionCaptures,
                for: paramNode.range,
                performanceCollector: performanceCollector
            ),
               !NSEqualRanges(enclosingFn.range, functionRange)
            {
                continue
            }
            var external: String? = nil
            var local: String? = nil
            var type: String? = nil

            // Get details from captures within this param node
            if let extCap = index.firstCapture(named: "swift.param.external", containedIn: paramNode.range) {
                external = nsContent.substring(with: extCap.range)
            }
            if let locCap = index.firstCapture(named: "swift.param.local", containedIn: paramNode.range) {
                local = nsContent.substring(with: locCap.range)
            }
            let paramText = nsContent.substring(with: paramNode.range)
            let parameterTypeResolutionStart = performanceCollector == nil ? 0 : CFAbsoluteTimeGetCurrent()
            if let typeCap = index.firstCapture(named: "swift.param.type", containedIn: paramNode.range) {
                performanceCollector?.swiftParameterTypeDirectCaptureCount += 1
                type = nsContent.substring(with: typeCap.range)
            } else if let parsedType = extractSwiftParamType(
                from: paramText,
                performanceCollector: performanceCollector
            ) {
                type = parsedType
            }
            if let performanceCollector {
                performanceCollector.swiftParameterTypeResolutionDuration +=
                    CFAbsoluteTimeGetCurrent() - parameterTypeResolutionStart
            }

            if let localName = local {
                let ext = (external == "_") ? "_" : external
                params.append(ParameterInfo(externalName: ext, localName: localName, typeName: type))
                if let typeName = type {
                    referencedTypes.insert(rawType: typeName)
                }
            }
        }

        return params
    }

	private static func signatureEndLocation(
		forFunctionRange functionRange: NSRange,
		nsContent: NSString,
		performanceCollector: CodeMapPerformanceCollector?
	) -> Int {
        let end = NSMaxRange(functionRange)
		var i = functionRange.location
		defer {
			let visited = max(0, min(i, end) - functionRange.location + (i < end ? 1 : 0))
			performanceCollector?.swiftSignatureCodeUnitVisits += visited
		}
        var parenDepth = 0
        var inString = false
        var escapeNext = false
        var inLineComment = false
        var inBlockComment = false

        while i < end {
            let ch = nsContent.character(at: i)

            if inLineComment {
                if ch == 0x0A { // \n
                    inLineComment = false
                }
                i += 1
                continue
            }

            if inBlockComment {
                if ch == 0x2A, i + 1 < end, nsContent.character(at: i + 1) == 0x2F { // */
                    inBlockComment = false
                    i += 2
                    continue
                }
                i += 1
                continue
            }

            if inString {
                if escapeNext {
                    escapeNext = false
                    i += 1
                    continue
                }
                if ch == 0x5C { // \\
                    escapeNext = true
                    i += 1
                    continue
                }
                if ch == 0x22 { // "
                    inString = false
                }
                i += 1
                continue
            }

            if ch == 0x22 { // "
                inString = true
                i += 1
                continue
            }

            if ch == 0x2F, i + 1 < end {
                let next = nsContent.character(at: i + 1)
                if next == 0x2F { // //
                    inLineComment = true
                    i += 2
                    continue
                }
                if next == 0x2A { // /*
                    inBlockComment = true
                    i += 2
                    continue
                }
            }

            if ch == 0x28 { // (
                parenDepth += 1
            } else if ch == 0x29 { // )
                if parenDepth > 0 {
                    parenDepth -= 1
                }
            } else if ch == 0x7B, parenDepth == 0 { // {
                return i
            }

            i += 1
        }

        return end
    }

    static func extractSwiftParamType(
        from paramText: String,
        performanceCollector: CodeMapPerformanceCollector? = nil
    ) -> String? {
        var inputUTF8ByteCount = 0
        var containsNonASCII = false
        for byte in paramText.utf8 {
            inputUTF8ByteCount += 1
            if byte >= 0x80 {
                containsNonASCII = true
            }
        }

        performanceCollector?.swiftParameterTypeFallbackParserCount += 1
        performanceCollector?.swiftParameterTypeInputUTF8ByteCount += inputUTF8ByteCount

        if containsNonASCII {
            performanceCollector?.swiftParameterTypeUnicodeLegacyFallbackCount += 1
            let legacyStart = performanceCollector == nil ? 0 : CFAbsoluteTimeGetCurrent()
            let result = extractSwiftParamTypeLegacy(from: paramText)
            if let performanceCollector {
                performanceCollector.swiftParameterTypeLegacyFallbackDuration +=
                    CFAbsoluteTimeGetCurrent() - legacyStart
            }
            return result
        }

        performanceCollector?.swiftParameterTypeASCIIFastPathCount += 1
        let utf8 = paramText.utf8
        guard let colonIndex = firstTopLevelASCIISwiftDelimiter(
            0x3A,
            in: utf8,
            from: utf8.startIndex
        ) else { return nil }
        let afterColonStart = utf8.index(after: colonIndex)
        let afterColon: Substring
        if let equalIndex = firstTopLevelASCIISwiftDelimiter(
            0x3D,
            in: utf8,
            from: afterColonStart
        ) {
            afterColon = paramText[afterColonStart ..< equalIndex]
        } else {
            afterColon = paramText[afterColonStart...]
        }
        let trimmed = afterColon.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func extractSwiftParamTypeLegacy(from paramText: String) -> String? {
        let parameter = paramText[...]
        guard let colonIndex = firstTopLevelSwiftDelimiter(":", in: parameter) else { return nil }
        var afterColon = parameter[parameter.index(after: colonIndex)...]
        if let eqIndex = firstTopLevelSwiftDelimiter("=", in: afterColon) {
            afterColon = afterColon[..<eqIndex]
        }
        let trimmed = afterColon.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func firstTopLevelASCIISwiftDelimiter(
        _ target: UInt8,
        in utf8: String.UTF8View,
        from startIndex: String.UTF8View.Index
    ) -> String.UTF8View.Index? {
        var delimiterStack: [UInt8] = []
        var stringDelimiter: (pounds: Int, quotes: Int)?
        var index = startIndex

        while index < utf8.endIndex {
            if let activeStringDelimiter = stringDelimiter {
                if utf8[index] == 0x5C, activeStringDelimiter.pounds == 0 {
                    index = utf8.index(after: index)
                    if index < utf8.endIndex {
                        index = utf8.index(after: index)
                    }
                    continue
                }

                var terminatorEnd = index
                var isTerminator = true
                for _ in 0 ..< activeStringDelimiter.quotes {
                    guard terminatorEnd < utf8.endIndex, utf8[terminatorEnd] == 0x22 else {
                        isTerminator = false
                        break
                    }
                    terminatorEnd = utf8.index(after: terminatorEnd)
                }
                if isTerminator {
                    for _ in 0 ..< activeStringDelimiter.pounds {
                        guard terminatorEnd < utf8.endIndex, utf8[terminatorEnd] == 0x23 else {
                            isTerminator = false
                            break
                        }
                        terminatorEnd = utf8.index(after: terminatorEnd)
                    }
                }
                if isTerminator {
                    index = terminatorEnd
                    stringDelimiter = nil
                    continue
                }

                index = utf8.index(after: index)
                continue
            }

            var quoteIndex = index
            var poundCount = 0
            while quoteIndex < utf8.endIndex, utf8[quoteIndex] == 0x23 {
                poundCount += 1
                quoteIndex = utf8.index(after: quoteIndex)
            }
            if quoteIndex < utf8.endIndex, utf8[quoteIndex] == 0x22 {
                var openerEnd = utf8.index(after: quoteIndex)
                var quoteCount = 1
                if openerEnd < utf8.endIndex, utf8[openerEnd] == 0x22 {
                    let thirdQuoteIndex = utf8.index(after: openerEnd)
                    if thirdQuoteIndex < utf8.endIndex, utf8[thirdQuoteIndex] == 0x22 {
                        quoteCount = 3
                        openerEnd = utf8.index(after: thirdQuoteIndex)
                    }
                }
                stringDelimiter = (poundCount, quoteCount)
                index = openerEnd
                continue
            }

            let byte = utf8[index]
            switch byte {
            case 0x28, 0x5B, 0x7B:
                delimiterStack.append(byte)
            case 0x29:
                if delimiterStack.last == 0x28 { delimiterStack.removeLast() }
            case 0x5D:
                if delimiterStack.last == 0x5B { delimiterStack.removeLast() }
            case 0x7D:
                if delimiterStack.last == 0x7B { delimiterStack.removeLast() }
            default:
                if byte == target, delimiterStack.isEmpty {
                    return index
                }
            }
            index = utf8.index(after: index)
        }

        return nil
    }

	private static func firstTopLevelSwiftDelimiter(
		_ target: Character,
		in text: Substring
	) -> String.Index? {
		let characters = Array(text)
		var delimiterStack: [Character] = []
		var stringDelimiter: (pounds: Int, quotes: Int)?
		var offset = 0

		while offset < characters.count {
			if let activeStringDelimiter = stringDelimiter {
				if characters[offset] == "\\", activeStringDelimiter.pounds == 0 {
					offset = min(offset + 2, characters.count)
					continue
				}
				if isSwiftStringTerminator(
					at: offset,
					characters: characters,
					delimiter: activeStringDelimiter
				) {
					offset += activeStringDelimiter.quotes + activeStringDelimiter.pounds
					stringDelimiter = nil
					continue
				}
				offset += 1
				continue
			}

			if let opening = swiftStringDelimiterStarting(at: offset, characters: characters) {
				stringDelimiter = (opening.pounds, opening.quotes)
				offset += opening.pounds + opening.quotes
				continue
			}

			let character = characters[offset]
			switch character {
			case "(", "[", "{":
				delimiterStack.append(character)
			case ")":
				if delimiterStack.last == "(" { delimiterStack.removeLast() }
			case "]":
				if delimiterStack.last == "[" { delimiterStack.removeLast() }
			case "}":
				if delimiterStack.last == "{" { delimiterStack.removeLast() }
			default:
				if character == target, delimiterStack.isEmpty {
					return text.index(text.startIndex, offsetBy: offset)
				}
			}
			offset += 1
		}

		return nil
	}

	private static func swiftStringDelimiterStarting(
		at offset: Int,
		characters: [Character]
	) -> (pounds: Int, quotes: Int)? {
		var quoteOffset = offset
		while quoteOffset < characters.count, characters[quoteOffset] == "#" {
			quoteOffset += 1
		}
		guard quoteOffset < characters.count, characters[quoteOffset] == "\"" else { return nil }
		let quoteCount = quoteOffset + 2 < characters.count &&
			characters[quoteOffset + 1] == "\"" && characters[quoteOffset + 2] == "\"" ? 3 : 1
		return (quoteOffset - offset, quoteCount)
	}

	private static func isSwiftStringTerminator(
		at offset: Int,
		characters: [Character],
		delimiter: (pounds: Int, quotes: Int)
	) -> Bool {
		guard offset + delimiter.quotes + delimiter.pounds <= characters.count else { return false }
		for quoteOffset in 0 ..< delimiter.quotes where characters[offset + quoteOffset] != "\"" {
			return false
		}
		for poundOffset in 0 ..< delimiter.pounds
		where characters[offset + delimiter.quotes + poundOffset] != "#" {
			return false
		}
		return true
	}

	static func extractSwiftReturnType(from signature: String, perfStats: CodeMapPerformanceCollector? = nil) -> String? {
        if let fast = SwiftSignatureParser.extractReturnType(from: signature) {
            perfStats?.swiftReturnTypeFastPathHits += 1
            return fast
        }
        if let match = LanguageTypeExtractor.matchAnyFunctionLine(signature, language: .swift, stats: perfStats),
           let returnType = match["returnType"],
           !returnType.isEmpty
        {
            return returnType.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

}
