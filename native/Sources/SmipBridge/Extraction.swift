import CPCRE2
import Crypto
import Foundation
import RepoPromptCodeMapCore
import RepoPromptRegexCore

struct Extraction {
    let fingerprint: CodeMapSHA256Digest
    let engine: [String: Any]

    init() throws {
        let version = try Self.configString(PCRE2_CONFIG_VERSION)
        let unicode = try Self.configString(PCRE2_CONFIG_UNICODE_VERSION)
        guard version == "10.49 2026-09-28", unicode == "17.0.0" else { throw BridgeFailure("regexEngineMismatch") }
        let expected: [(Int32, UInt32)] = [
            (PCRE2_CONFIG_COMPILED_WIDTHS, 1), (PCRE2_CONFIG_UNICODE, 1),
            (PCRE2_CONFIG_JIT, 1), (PCRE2_CONFIG_BSR, 1), (PCRE2_CONFIG_NEWLINE, 2),
            (PCRE2_CONFIG_LINKSIZE, 2), (PCRE2_CONFIG_PARENSLIMIT, 250),
            (PCRE2_CONFIG_MATCHLIMIT, 10_000_000), (PCRE2_CONFIG_DEPTHLIMIT, 10_000_000),
            (PCRE2_CONFIG_HEAPLIMIT, 20_000_000), (PCRE2_CONFIG_NEVER_BACKSLASH_C, 0),
        ]
        for (selector, value) in expected {
            var actual: UInt32 = 0
            guard pcre2_config_8(UInt32(selector), &actual) == 0, actual == value else { throw BridgeFailure("regexEngineMismatch") }
        }
        let mode = RepoPromptRegexRuntime.pcre2JITMode
        let policy = switch mode {
        case .disabled: "disabled"
        case .auto: "auto"
        case .required: "required"
        }
        let probe = try PCRE2Regex("^(é)(.)$", jit: mode)
        let jitExecution: String
        switch probe.jitStatus {
        case .disabled: jitExecution = "disabled"
        case let .compiled(sizeBytes):
            guard sizeBytes > 0 else { throw BridgeFailure("regexEngineMismatch") }
            jitExecution = "compiled"
        case .unavailable, .fallback: jitExecution = "unavailable"
        }
        guard try probe.firstMatch(in: "é🙂")?.byteRange == 0 ..< 6 else { throw BridgeFailure("regexEngineMismatch") }
        guard let recipeBytes = Data(base64Encoded: EngineRecipe.canonicalBase64) else {
            throw BridgeFailure("missingRegexRecipe")
        }
        let recipe = try JSONDecoder().decode(Recipe.self, from: recipeBytes)
        guard recipe.release == "10.49", recipe.unicodeVersion == unicode else { throw BridgeFailure("regexEngineMismatch") }
        engine = ["version": version, "unicode": unicode, "jitPolicy": policy, "jitCapability": true, "jitExecution": jitExecution]
        let identity: [String: Any] = [
            "domain": "smip-regex-engine-v1", "release": recipe.release, "commit": recipe.commit,
            "archiveSHA256": recipe.archiveSHA256, "sljitCommit": recipe.sljitCommit,
            "patches": recipe.patches, "unicodeVersion": unicode, "codeUnitWidth": 8,
            "compileSettings": recipe.cmake, "jitPolicy": policy, "jitCapability": true, "jitExecution": jitExecution,
        ]
        let bytes = try JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys, .withoutEscapingSlashes])
        fingerprint = try CodeMapSHA256Digest(bytes: Data(SHA256.hash(data: bytes)))
    }

    func describe() throws -> [String: Any] {
        let extensions = try CodeMapSyntaxEngine.extensionToLanguage.sorted { $0.key < $1.key }.map { ext, language -> [String: Any] in
            return try ["extension": ext, "pipelineCanonicalBase64": pipeline(language).canonicalBytes.base64EncodedString()]
        }
        return ["kind": "description", "decoderPolicy": RPCESourceDecoder.identifier,
                "regexEngineFingerprint": fingerprint.lowercaseHex, "engine": engine, "extensions": extensions,
                "limits": ["lines": CodeMapSyntaxEngine.parseLineLimit, "utf16Units": CodeMapSyntaxEngine.parseUTF16Limit, "utf8Bytes": CodeMapSyntaxEngine.parseUTF8Limit]]
    }

    func extract(extension ext: String, bytes: Data, expected: SourceIdentity) throws -> [String: Any] {
        let digest = CodeMapRawSourceDigest(bytes: Data(SHA256.hash(data: bytes)))
        let identity = SourceIdentity(sha256: digest.lowercaseHex, byteCount: bytes.count)
        guard identity == expected else { throw BridgeFailure("sourceChanged") }
        guard let language = CodeMapSyntaxEngine.shared.language(forFileExtension: ext) else { return ["kind": "unsupportedExtension"] }
        let decoded = RPCESourceDecoder.decode(bytes)
        let source = CodeMapCoreSourceSnapshot(
            rawByteCount: bytes.count, rawSHA256: digest,
            decoderPolicy: RPCESourceDecoder.policy, decodeResult: decoded
        )
        let outcome = try CodeMapSyntaxArtifactBuilder.build(source: source, language: language)
        let projection: Any = if case let .ready(artifact) = outcome {
            ["apiDescription": artifact.apiDescription, "definedTypeNames": artifact.definedTypeNames.sorted()]
        } else { NSNull() }
        return try ["kind": "extracted", "key": key(source, language: language),
                    "outcome": JSONSerialization.jsonObject(with: JSONEncoder().encode(outcome)), "projection": projection]
    }

    func key(_ digest: CodeMapRawSourceDigest, byteCount: Int, extension ext: String) throws -> Any {
        guard let language = CodeMapSyntaxEngine.shared.language(forFileExtension: ext) else { return NSNull() }
        let key = try CodeMapArtifactKey(rawSHA256: digest, rawByteCount: UInt64(byteCount), pipelineIdentity: pipeline(language))
        return ["canonicalBase64": key.canonicalBytes.base64EncodedString(), "digest": key.storageDigestHex]
    }

    private func key(_ source: CodeMapCoreSourceSnapshot, language: LanguageType) throws -> [String: Any] {
        let key = try CodeMapArtifactKey(source: source, pipelineIdentity: pipeline(language))
        return ["canonicalBase64": key.canonicalBytes.base64EncodedString(), "digest": key.storageDigestHex]
    }

    private func pipeline(_ language: LanguageType) throws -> CodeMapPipelineIdentity {
        try CodeMapSyntaxEngine.shared.pipelineIdentity(
            for: language, decoderPolicy: RPCESourceDecoder.policy, regexEngineFingerprint: fingerprint
        )
    }

    static func identity(_ bytes: Data) -> SourceIdentity {
        SourceIdentity(sha256: CodeMapRawSourceDigest(bytes: Data(SHA256.hash(data: bytes))).lowercaseHex, byteCount: bytes.count)
    }

    private static func configString(_ selector: Int32) throws -> String {
        let count = pcre2_config_8(UInt32(selector), nil)
        guard count > 0 else { throw BridgeFailure("regexEngineMismatch") }
        var bytes = [UInt8](repeating: 0, count: Int(count))
        let result = bytes.withUnsafeMutableBytes { pcre2_config_8(UInt32(selector), $0.baseAddress) }
        guard result == count, bytes.last == 0, let value = String(bytes: bytes.dropLast(), encoding: .utf8) else { throw BridgeFailure("regexEngineMismatch") }
        return value
    }
}

private struct Recipe: Decodable {
    let release: String
    let commit: String
    let archiveSHA256: String
    let sljitCommit: String
    let patches: [String]
    let unicodeVersion: String
    let cmake: [String: String]
}
