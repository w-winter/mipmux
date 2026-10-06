// Modified for smip: declarations relocated and cross-file access adjusted.
import Foundation
import CoreFoundation

extension SwiftCodeMapStrategy {
	enum SwiftASCIIPropertyTypeResolution: Equatable {
		case type(String)
		case noType
		case fallback
	}

	private static let swiftPropertyModifierKeywords = [
		"private(set)", "public", "private", "internal", "fileprivate", "open",
		"class", "static", "final", "lazy", "override", "mutating", "actor", "inout",
		"required", "convenience", "indirect", "weak", "unowned", "dynamic", "distributed", "isolated",
	]

	static func extractSwiftPropertyType(
		from declaration: String,
		perfStats: CodeMapPerformanceCollector? = nil
	) -> String? {
		let resolutionStart = perfStats == nil ? 0 : CFAbsoluteTimeGetCurrent()
		perfStats?.swiftPropertyTypeResolutionCount += 1
		defer {
			if let perfStats {
				perfStats.swiftPropertyTypeResolutionDuration +=
					CFAbsoluteTimeGetCurrent() - resolutionStart
			}
		}

		var inputUTF8ByteCount = 0
		var containsNonASCII = false
		for byte in declaration.utf8 {
			inputUTF8ByteCount += 1
			if byte >= 0x80 {
				containsNonASCII = true
			}
		}
		perfStats?.swiftPropertyTypeInputUTF8ByteCount += inputUTF8ByteCount

		if containsNonASCII {
			perfStats?.swiftPropertyTypeLegacyFallbackCount += 1
			perfStats?.swiftPropertyTypeUnicodeLegacyFallbackCount += 1
			let legacyStart = perfStats == nil ? 0 : CFAbsoluteTimeGetCurrent()
			let result = extractSwiftPropertyTypeLegacy(from: declaration, perfStats: perfStats)
			if let perfStats {
				perfStats.swiftPropertyTypeLegacyFallbackDuration +=
					CFAbsoluteTimeGetCurrent() - legacyStart
			}
			return result
		}

		let fastPathStart = perfStats == nil ? 0 : resolutionStart
		let resolution = resolveSwiftASCIIPropertyType(in: declaration.utf8)
		if let perfStats {
			perfStats.swiftPropertyTypeASCIIFastPathDuration +=
				CFAbsoluteTimeGetCurrent() - fastPathStart
		}

		switch resolution {
		case let .type(type):
			perfStats?.swiftPropertyTypeASCIIDirectTypeCount += 1
			return type
		case .noType:
			perfStats?.swiftPropertyTypeASCIIDirectNilCount += 1
			return nil
		case .fallback:
			perfStats?.swiftPropertyTypeLegacyFallbackCount += 1
			perfStats?.swiftPropertyTypeASCIIIneligibleFallbackCount += 1
			let legacyStart = perfStats == nil ? 0 : CFAbsoluteTimeGetCurrent()
			let result = extractSwiftPropertyTypeLegacy(from: declaration, perfStats: perfStats)
			if let perfStats {
				perfStats.swiftPropertyTypeLegacyFallbackDuration +=
					CFAbsoluteTimeGetCurrent() - legacyStart
			}
			return result
		}
	}

	static func extractSwiftPropertyTypeLegacy(
		from declaration: String,
		perfStats: CodeMapPerformanceCollector? = nil
	) -> String? {
        if let match = LanguageTypeExtractor.matchAnyVariableLine(declaration, language: .swift, stats: perfStats),
           let propType = match["type"],
           !propType.isEmpty
        {
            return propType.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

	static func resolveSwiftASCIIPropertyType(
		in utf8: String.UTF8View
	) -> SwiftASCIIPropertyTypeResolution {
		var index = utf8.startIndex
		let end = utf8.endIndex

		for byte in utf8 where byte >= 0x80 {
			return .fallback
		}
		if containsAmbiguousSwiftPropertyByteSequence(in: utf8) {
			return .fallback
		}

		if index < end, utf8[index] == 0x2D || utf8[index] == 0x2A {
			index = utf8.index(after: index)
		}
		skipASCIIWhitespace(in: utf8, index: &index)

		while index < end, utf8[index] == 0x40 {
			index = utf8.index(after: index)
			guard index < end, isASCIIIdentifierStart(utf8[index]) else { return .fallback }
			index = utf8.index(after: index)
			while index < end, isASCIIIdentifierContinuation(utf8[index]) {
				index = utf8.index(after: index)
			}
			if index < end, utf8[index] == 0x28 {
				index = utf8.index(after: index)
				while index < end, utf8[index] != 0x29 {
					let byte = utf8[index]
					if byte == 0x28 || !isSafeASCIIAttributeArgumentByte(byte) {
						return .fallback
					}
					index = utf8.index(after: index)
				}
				guard index < end else { return .fallback }
				index = utf8.index(after: index)
			}
			skipASCIIWhitespace(in: utf8, index: &index)
		}

		while true {
			if let afterKeyword = matchingASCIIKeyword("var", in: utf8, at: index),
				afterKeyword < end,
				isASCIIWhitespace(utf8[afterKeyword])
			{
				index = afterKeyword
				skipASCIIWhitespace(in: utf8, index: &index)
				break
			}
			if let afterKeyword = matchingASCIIKeyword("let", in: utf8, at: index),
				afterKeyword < end,
				isASCIIWhitespace(utf8[afterKeyword])
			{
				index = afterKeyword
				skipASCIIWhitespace(in: utf8, index: &index)
				break
			}

			var matchedModifier = false
			for modifier in swiftPropertyModifierKeywords {
				guard let afterModifier = matchingASCIIKeyword(modifier, in: utf8, at: index),
						afterModifier < end,
						isASCIIWhitespace(utf8[afterModifier])
				else { continue }
				index = afterModifier
				skipASCIIWhitespace(in: utf8, index: &index)
				matchedModifier = true
				break
			}
			if !matchedModifier {
				return .fallback
			}
		}

		guard index < end, isASCIIIdentifierStart(utf8[index]) else { return .fallback }
		index = utf8.index(after: index)
		while index < end, isASCIIIdentifierContinuation(utf8[index]) {
			index = utf8.index(after: index)
		}
		skipASCIIWhitespace(in: utf8, index: &index)
		guard index < end else { return .noType }
		guard utf8[index] == 0x3A else { return .fallback }
		index = utf8.index(after: index)
		let afterColon = index
		skipASCIIWhitespace(in: utf8, index: &index)
		if index == end {
			return afterColon == end ? .noType : .fallback
		}

		let typeStart = index
		var typeEnd = end
		var delimiters: [UInt8] = []
		var sawLineBreak = false
		while index < end {
			let byte = utf8[index]
			if sawLineBreak, !isASCIIWhitespace(byte) {
				return .fallback
			}
			if byte == 0x0A || byte == 0x0D {
				sawLineBreak = true
			}

			switch byte {
			case 0x28, 0x5B, 0x3C:
				delimiters.append(byte)
			case 0x29:
				guard delimiters.last == 0x28 else { return .fallback }
				delimiters.removeLast()
			case 0x5D:
				guard delimiters.last == 0x5B else { return .fallback }
				delimiters.removeLast()
			case 0x3E:
				let previous = index > typeStart ? utf8[utf8.index(before: index)] : 0
				if previous != 0x2D {
					guard delimiters.last == 0x3C else { return .fallback }
					delimiters.removeLast()
				}
			case 0x3D:
				guard delimiters.isEmpty else { return .fallback }
				let next = utf8.index(after: index)
				guard next == end || utf8[next] != 0x3D else { return .fallback }
				typeEnd = index
				index = end
				continue
			case 0x2C:
				guard !delimiters.isEmpty else { return .fallback }
			default:
				guard isSafeASCIIPropertyTypeByte(byte) else { return .fallback }
			}
			index = utf8.index(after: index)
		}
		guard delimiters.isEmpty else { return .fallback }

		let type = String(decoding: utf8[typeStart ..< typeEnd], as: UTF8.self)
			.trimmingCharacters(in: .whitespacesAndNewlines)
		return type.isEmpty ? .noType : .type(type)
	}

	private static func containsAmbiguousSwiftPropertyByteSequence(
		in utf8: String.UTF8View
	) -> Bool {
		var index = utf8.startIndex
		while index < utf8.endIndex {
			switch utf8[index] {
			case 0x22, 0x23, 0x5C, 0x7B, 0x7D:
				return true
			case 0x2F:
				return true
			default:
				index = utf8.index(after: index)
			}
		}
		return false
	}

	private static func skipASCIIWhitespace(
		in utf8: String.UTF8View,
		index: inout String.UTF8View.Index
	) {
		while index < utf8.endIndex, isASCIIWhitespace(utf8[index]) {
			index = utf8.index(after: index)
		}
	}

	private static func matchingASCIIKeyword(
		_ keyword: String,
		in utf8: String.UTF8View,
		at start: String.UTF8View.Index
	) -> String.UTF8View.Index? {
		var index = start
		for expected in keyword.utf8 {
			guard index < utf8.endIndex, utf8[index] == expected else { return nil }
			index = utf8.index(after: index)
		}
		return index
	}

	private static func isASCIIWhitespace(_ byte: UInt8) -> Bool {
		byte == 0x20 || (0x09 ... 0x0D).contains(byte)
	}

	private static func isASCIIIdentifierStart(_ byte: UInt8) -> Bool {
		byte == 0x5F || (0x41 ... 0x5A).contains(byte) || (0x61 ... 0x7A).contains(byte)
	}

	private static func isASCIIIdentifierContinuation(_ byte: UInt8) -> Bool {
		isASCIIIdentifierStart(byte) || (0x30 ... 0x39).contains(byte)
	}

	private static func isSafeASCIIAttributeArgumentByte(_ byte: UInt8) -> Bool {
		isASCIIIdentifierContinuation(byte) || isASCIIWhitespace(byte) || [
			0x2C, 0x2E, 0x2D, 0x2B, 0x3A, 0x3D, 0x3F, 0x21, 0x26, 0x3C, 0x3E,
			0x5B, 0x5D,
		].contains(byte)
	}

	private static func isSafeASCIIPropertyTypeByte(_ byte: UInt8) -> Bool {
		isASCIIIdentifierContinuation(byte) || isASCIIWhitespace(byte) || [
			0x2E, 0x3F, 0x21, 0x3A, 0x26, 0x2D, 0x40,
		].contains(byte)
	}

    static func extractSwiftPropertyDeclaration(
        from identifierRange: NSRange,
        index: CodeMapCaptureIndex,
		nsContent: NSString,
		performanceCollector: CodeMapPerformanceCollector?,
        fallback: () -> String
    ) -> String {
		let lookupStart = performanceCollector.map { _ in CFAbsoluteTimeGetCurrent() }
        let declCap = index.smallestCapture(
            named: "swift.property.decl",
            containing: identifierRange
        ) ?? index.smallestCapture(
            named: "swift.protocol.property.decl",
            containing: identifierRange
        )
		if let lookupStart {
			performanceCollector?.swiftPropertyDeclarationLookupDuration +=
				CFAbsoluteTimeGetCurrent() - lookupStart
		}
        if let cap = declCap {
			let substringStart = performanceCollector.map { _ in CFAbsoluteTimeGetCurrent() }
            var decl = nsContent.substring(with: cap.range)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let braceIndex = decl.firstIndex(of: "{") {
                decl = String(decl[..<braceIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
			if let substringStart {
				performanceCollector?.swiftPropertyDeclarationSubstringDuration +=
					CFAbsoluteTimeGetCurrent() - substringStart
			}
			let initializerStart = performanceCollector.map { _ in CFAbsoluteTimeGetCurrent() }
            decl = stripSwiftInitializer(decl)
			if let initializerStart {
				performanceCollector?.swiftPropertyInitializerStripDuration +=
					CFAbsoluteTimeGetCurrent() - initializerStart
			}
            return decl
        }
        return fallback()
    }

    private static func stripSwiftInitializer(_ declaration: String) -> String {
        let trimmed = declaration.trimmingCharacters(in: .whitespacesAndNewlines)
        if let eqIndex = TopLevelScanner.firstTopLevelIndex(of: "=", in: trimmed, track: .all) {
            return String(trimmed[..<eqIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return trimmed
    }
}
