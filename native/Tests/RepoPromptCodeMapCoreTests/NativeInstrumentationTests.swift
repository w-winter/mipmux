import Foundation
import RepoPromptCodeMapCore
import XCTest

final class NativeInstrumentationTests: XCTestCase {
    func testAllLanguageFixturesHaveIdenticalCompleteOutcomesWithInstrumentation() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        for fixture in try CodeMapFixtureRunner.loadFixtures(relativePaths: CodeMapFixtureRunner.allFixtureRelativePaths) {
            let language = try XCTUnwrap(CodeMapSyntaxEngine.shared.language(forFileExtension: fixture.fileExtension))
            let source = CodeMapFixtureRunner.makeSourceSnapshot(content: fixture.content)
            let plain = try CodeMapSyntaxArtifactBuilder.build(source: source, language: language)
            let collector = CodeMapPerformanceCollector(collectsCaptureNames: true)
            let measured = try CodeMapSyntaxArtifactBuilder.build(
                source: source, language: language, performanceOptions: .countersOnly,
                performanceCollector: collector,
            )
            XCTAssertEqual(try encoder.encode(plain), try encoder.encode(measured), fixture.relativePath)
            XCTAssertGreaterThan(collector.syntaxCaptures, 0, fixture.relativePath)
            XCTAssertEqual(collector.capturesProcessed, collector.syntaxCaptures, fixture.relativePath)
            if case let .ready(plainArtifact) = plain, case let .ready(measuredArtifact) = measured {
                XCTAssertEqual(Data(plainArtifact.apiDescription.utf8), Data(measuredArtifact.apiDescription.utf8))
                XCTAssertEqual(plainArtifact.definedTypeNames.sorted(), measuredArtifact.definedTypeNames.sorted())
            }
        }
    }
}
