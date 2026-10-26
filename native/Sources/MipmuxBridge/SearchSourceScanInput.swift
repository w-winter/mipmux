import Foundation
import RepoPromptCodeMapCore

/// A confined source read whose bytes matched their identity before and after the read.
struct ConfinedSource {
    let content: Data
    let digest: CodeMapRawSourceDigest
    let identity: SourceIdentity
    let fingerprint: DescriptorFingerprint
}

/// Reads, decodes and scans search candidates in order, sharing one result limit as the per-file scans do. A binary
/// file, by RPCE's probe, or an undecodable one is skipped; a read failure is reported for that file and scanning
/// continues.
struct SearchSourceScanInput {
    private struct Candidate {
        let root: NativeHandle
        let path: String
        let expected: SourceIdentity
    }

    private let candidates: [Candidate]
    private let pattern: String
    private let isRegex: Bool
    private let caseSensitive: Bool
    private let wholeWord: Bool
    private let countOnly: Bool
    private let limit: Int

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: [
            "kind", "files", "pattern", "isRegex", "caseSensitive", "wholeWord", "countOnly", "limit"
        ])
        guard let files = try input.value("files") as? [Any] else { throw BridgeFailure("nativeProtocolError") }
        candidates = try files.map { entry in
            let file = try WireObject(entry, keys: ["root", "path", "expected"])
            return try Candidate(root: NativeHandle(file.value("root")), path: file.string("path"),
                                 expected: SourceIdentity(file.value("expected")))
        }
        pattern = try input.text("pattern")
        isRegex = try input.boolean("isRegex")
        caseSensitive = try input.boolean("caseSensitive")
        wholeWord = try input.boolean("wholeWord")
        countOnly = try input.boolean("countOnly")
        limit = try input.integer("limit")
    }

    func render(files: ConfinedFiles) throws -> [String: Any] {
        var remaining = limit
        var outcomes: [[String: Any]] = []
        for candidate in candidates {
            let source: ConfinedSource?
            do {
                source = try files.readConfinedSource(
                    candidate.root, path: candidate.path, expected: candidate.expected
                ) { try RPCEBinaryProbe.isBinary(path: candidate.path, descriptor: $0) }
            } catch let failure as BridgeFailure {
                let number: Any = failure.number.map { $0 as Any } ?? NSNull()
                outcomes.append(["kind": "failed", "code": failure.code, "errno": number])
                continue
            }
            guard let text = Self.decodedText(source) else {
                outcomes.append(["kind": "skipped"])
                continue
            }
            let result = try scan(text, limit: remaining)
            let matchingLines = (result["matchingLines"] as? Int) ?? 0
            remaining -= matchingLines
            outcomes.append(["kind": "decoded", "textIdentity": Extraction.identity(Data(text.utf8)).json,
                             "result": result, "text": matchingLines > 0 && !countOnly ? text : NSNull()])
        }
        return ["kind": "searchSourceScan", "files": outcomes]
    }

    /// The decoded text of a read source; nil for a file skipped as binary or undecodable.
    private static func decodedText(_ source: ConfinedSource?) -> String? {
        guard let source else { return nil }
        if case let .decoded(decoded) = RPCESourceDecoder.decode(source.content) { return decoded.text }
        return nil
    }

    private func scan(_ text: String, limit: Int) throws -> [String: Any] {
        if isRegex {
            return try RegexSearchInput(text: text, pattern: pattern, caseSensitive: caseSensitive,
                                        wholeWord: wholeWord, countOnly: countOnly, limit: limit).render()
        }
        return try LiteralSearchInput(text: text, pattern: pattern, caseSensitive: caseSensitive,
                                      wholeWord: wholeWord, countOnly: countOnly, limit: limit).render()
    }
}
