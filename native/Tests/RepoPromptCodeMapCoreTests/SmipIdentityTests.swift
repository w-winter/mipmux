import Foundation
import RepoPromptCodeMapCore
import XCTest

final class SmipIdentityTests: XCTestCase {
    func testDependencyFingerprintAndDecoderParticipateInCanonicalKey() throws {
        let first = try CodeMapSyntaxEngine.shared.pipelineIdentity(
            for: .swift, decoderPolicy: .workspaceAutomaticLinuxV1,
            regexEngineFingerprint: CodeMapSHA256Digest(bytes: Data(repeating: 1, count: 32)),
        )
        let otherEngine = try CodeMapSyntaxEngine.shared.pipelineIdentity(
            for: .swift, decoderPolicy: .workspaceAutomaticV1,
            regexEngineFingerprint: CodeMapSHA256Digest(bytes: Data(repeating: 2, count: 32)),
        )
        let otherDecoder = try CodeMapSyntaxEngine.shared.pipelineIdentity(
            for: .swift, decoderPolicy: .workspaceAutomaticV1,
            regexEngineFingerprint: first.regexEngineFingerprint,
        )
        let sourceDigest = CodeMapRawSourceDigest(bytes: Data(repeating: 3, count: 32))
        let key = CodeMapArtifactKey(rawSHA256: sourceDigest, rawByteCount: 17, pipelineIdentity: first)
        for changed in [otherEngine, otherDecoder] {
            XCTAssertNotEqual(
                key.storageDigest,
                CodeMapArtifactKey(rawSHA256: sourceDigest, rawByteCount: 17, pipelineIdentity: changed).storageDigest,
            )
        }
        XCTAssertEqual(try CodeMapArtifactKey(canonicalBytes: key.canonicalBytes), key)
        XCTAssertEqual(try CodeMapPipelineIdentity(canonicalBytes: first.canonicalBytes), first)
        var wrongDomain = first.canonicalBytes
        wrongDomain[CodeMapPipelineIdentity.domain.utf8.count - 1] = UInt8(ascii: "1")
        XCTAssertThrowsError(try CodeMapPipelineIdentity(canonicalBytes: wrongDomain))
    }
}
