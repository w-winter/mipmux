import Dispatch
import Foundation
import RepoPromptRegexCore
import XCTest

final class PCRE2BoundaryTests: XCTestCase {
    func testJITMatchingLimitsAndIndependentSessions() throws {
        let required = try PCRE2Regex("^item-(\\d+)$", jit: .required)
        guard case let .compiled(sizeBytes) = required.jitStatus else { return XCTFail("Required JIT did not compile") }
        XCTAssertGreaterThan(sizeBytes, 0)
        DispatchQueue.concurrentPerform(iterations: 2) { index in
            do {
                try required.withMatchSession { session in
                    let digits = index == 0 ? "1" : "22"
                    XCTAssertEqual(try session.firstMatch(in: "item-" + digits)?.captureByteRanges[1], 5 ..< (5 + digits.count))
                    XCTAssertNil(try session.firstMatch(in: "other"))
                    XCTAssertTrue(try session.containsMatch(in: "item-" + digits))
                }
            } catch { XCTFail("Independent session failed: \(error)") }
        }
        XCTAssertNil(try required.firstMatch(in: "item-1", options: .notBOL))
        XCTAssertNil(try required.firstMatch(in: "item-1", options: .notEOL))
        let interpreter = try PCRE2Regex("^(a+)+$", jit: .disabled)
        for (limits, expected) in [
            (PCRE2MatchLimits(depthLimit: 1), PCRE2LimitKind.depth),
            (PCRE2MatchLimits(heapLimitKiB: 0), PCRE2LimitKind.heap),
        ] {
            XCTAssertThrowsError(try interpreter.firstMatch(in: String(repeating: "a", count: 64) + "!", matchLimits: limits)) { error in
                guard case let PCRE2Error.matchLimitExceeded(kind, _, _) = error else { return XCTFail("Missing limit result") }
                XCTAssertEqual(kind, expected)
            }
        }
        let recursive = try PCRE2Regex("^(a(?1)?b)$", jit: .required)
        XCTAssertThrowsError(try recursive.firstMatch(in: String(repeating: "a", count: 2000) + String(repeating: "b", count: 2000))) { error in
            guard case let PCRE2Error.matchLimitExceeded(kind, _, _) = error else { return XCTFail("Missing JIT stack limit result") }
            XCTAssertEqual(kind, .jitStack)
        }
    }

    func testRetainedASCIIHelpersKeepCountsRangesAndNonASCIIDispositions() throws {
        let literal = try XCTUnwrap(PCRE2ASCIIWholeWordLiteral(needle: "foo", caseInsensitive: true))
        let result = try XCTUnwrap(literal.scanMatchingLines(in: "FOO\r\nfoo_bar\rfoo\n", collectMatches: true, maxCollectedMatches: 1))
        XCTAssertEqual(result.lineMatchCount, 2)
        XCTAssertEqual(result.matchingLineNumbers, [0])
        XCTAssertNil(literal.scanMatchingLines(in: "é foo", collectMatches: true))
        let marker = try XCTUnwrap(PCRE2ASCIIMarkerLinePattern(marker: "TODO", digitCount: 3, requiredPrefix: "Search", caseInsensitive: false))
        let subject = "TODO-123: SearchThing\r\nignore\rTODO-456: SearchOther\n"
        let marked = try XCTUnwrap(marker.scanMatchingLineRanges(in: subject, maxCollectedMatches: 2))
        XCTAssertEqual(marked.lineMatchCount, 2)
        XCTAssertEqual(marked.hits.map(\.lineNumber), [0, 2])
        let bytes = Array(subject.utf8)
        XCTAssertEqual(marked.hits.map { String(decoding: bytes[$0.byteRange], as: UTF8.self) }, ["TODO-123: SearchThing", "TODO-456: SearchOther"])
        let declarations = try XCTUnwrap(RepoPromptPCRE2Adapter.anchoredDeclarationLinePlan(
            for: #"^\s*(?:final\s+)?(?:class|struct|func)\s+[A-Za-z_][A-Za-z0-9_]*"#, caseInsensitive: true,
        ))
        XCTAssertEqual(declarations.scanMatchingLines(in: "class One\r\n final struct Two\nfunc third\r", collectMatches: true)?.matchingLineNumbers, [0, 1, 2])
        XCTAssertEqual(declarations.scanMatchingLines(in: "class One", collectMatches: true, shouldCancel: { true })?.lineMatchCount, 0)
    }
}
