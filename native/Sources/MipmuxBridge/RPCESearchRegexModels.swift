// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation
import RepoPromptRegexCore

// swiftlint:disable function_body_length identifier_name
enum RPCESearchRegex {
    enum RegexEngine {
        case pcre2(PCRE2Regex)
        case asciiWholeWord(PCRE2ASCIIWholeWordLiteral)
        case anchoredDeclaration(PCRE2AnchoredDeclarationLinePattern, PCRE2Regex)
        case asciiMarker(PCRE2ASCIIMarkerLinePattern, RepoPromptPCRE2CompileRequest)
    }

    struct SearchHit {
        let lineNumber: Int
    }

    struct SearchScanSummary {
        let hits: [SearchHit]
        let lineMatchCount: Int

        var matchedFile: Bool {
            lineMatchCount > 0
        }
    }

    struct RegexScanTraits {
        let anchored: Bool
        let expensiveUnanchored: Bool
        let highRisk: Bool
        let linePrefilter: PCRE2LinePrefilter?
    }

    struct SearchLineIndex {
        let lineRanges: [NSRange]
        let lineStartsUTF16: [Int]
        let lineStartsUTF8: [Int]

        init(content: String) {
            let nsContent = content as NSString
            guard !content.isEmpty else {
                lineRanges = []
                lineStartsUTF16 = []
                lineStartsUTF8 = []
                return
            }

            var ranges: [NSRange] = []
            var startsUTF16: [Int] = []
            var startsUTF8: [Int] = []
            ranges.reserveCapacity(32)
            startsUTF16.reserveCapacity(32)
            startsUTF8.reserveCapacity(32)

            var lineStartUTF16 = 0
            var lineStartUTF8 = 0
            var offsetUTF16 = 0
            var offsetUTF8 = 0
            let scalars = content.unicodeScalars
            var index = scalars.startIndex

            func appendLine(endingAtUTF16 endUTF16: Int) {
                startsUTF16.append(lineStartUTF16)
                startsUTF8.append(lineStartUTF8)
                ranges.append(NSRange(location: lineStartUTF16, length: endUTF16 - lineStartUTF16))
            }

            func consume(_ scalar: UnicodeScalar) {
                offsetUTF16 += scalar.utf16.count
                offsetUTF8 += scalar.utf8.count
            }

            while index < scalars.endIndex {
                let scalar = scalars[index]
                if scalar.value == 13 || scalar.value == 10 { // CR or LF
                    appendLine(endingAtUTF16: offsetUTF16)
                    consume(scalar)
                    index = scalars.index(after: index)

                    if scalar.value == 13, index < scalars.endIndex, scalars[index].value == 10 {
                        consume(scalars[index])
                        index = scalars.index(after: index)
                    }

                    lineStartUTF16 = offsetUTF16
                    lineStartUTF8 = offsetUTF8
                } else {
                    consume(scalar)
                    index = scalars.index(after: index)
                }
            }

            if lineStartUTF16 < nsContent.length {
                startsUTF16.append(lineStartUTF16)
                startsUTF8.append(lineStartUTF8)
                ranges.append(NSRange(location: lineStartUTF16, length: nsContent.length - lineStartUTF16))
            }

            lineRanges = ranges
            lineStartsUTF16 = startsUTF16
            lineStartsUTF8 = startsUTF8
        }

        func lineNumber(forUTF16Offset offset: Int) -> Int {
            lineNumber(forOffset: offset, starts: lineStartsUTF16)
        }

        func lineNumber(forUTF8Offset offset: Int) -> Int {
            lineNumber(forOffset: offset, starts: lineStartsUTF8)
        }

        func lineNumber(forOffset offset: Int, starts: [Int]) -> Int {
            guard !starts.isEmpty else { return -1 }

            var lo = 0
            var hi = starts.count - 1
            while lo <= hi {
                let mid = (lo + hi) / 2
                if starts[mid] <= offset {
                    lo = mid + 1
                } else {
                    hi = mid - 1
                }
            }
            return max(0, min(lo - 1, starts.count - 1))
        }
    }

    struct SearchDocument {
        let text: String
        let lineIndex: SearchLineIndex
        var nsText: NSString {
            text as NSString
        }

        var lineRanges: [NSRange] {
            lineIndex.lineRanges
        }

        func lineNumber(forUTF8Offset offset: Int) -> Int {
            lineIndex.lineNumber(forUTF8Offset: offset)
        }

        func lineSlice(at lineNumber: Int) -> Substring {
            guard lineNumber >= 0, lineNumber < lineIndex.lineRanges.count,
                  let range = Range(lineIndex.lineRanges[lineNumber], in: text)
            else {
                return Substring()
            }
            return text[range]
        }
    }
}

// swiftlint:enable function_body_length identifier_name
