import Foundation
import RepoPromptCodeMapCore

/// A confined source read whose bytes matched their identity before and after the read.
struct ConfinedSource {
    let content: Data
    let digest: CodeMapRawSourceDigest
    let identity: SourceIdentity
    let fingerprint: DescriptorFingerprint
}

/// Reads, decodes and scans search candidates, sharing one result limit as the per-file scans do. A binary file, by
/// RPCE's probe, or an undecodable one is skipped; a read failure is reported for that file and scanning continues.
/// Candidates are read and decoded concurrently in batches, then scanned one at a time in candidate order, so the
/// running limit applies as it would to files scanned in sequence. Each file's outcome is emitted as its own frame once
/// scanned.
struct SearchSourceScanInput {
    private struct Candidate {
        let root: NativeHandle
        let path: String
        let expected: SourceIdentity
    }

    /// A candidate after its read and decoding, before its scan.
    private enum Prepared {
        case failed([String: Any])
        case skipped
        case decoded(text: String, textIdentity: [String: Any])
    }

    /// Bounds the expected bytes of one batch, and so the decoded text it holds until its files are scanned. A larger
    /// file forms a batch of its own.
    private static let batchBytes = 8 * 1024 * 1024

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

    func render(files: ConfinedFiles, request: Request) throws -> [String: Any] {
        var remaining = limit
        var start = candidates.startIndex
        while start < candidates.endIndex {
            let end = batchEnd(from: start)
            for prepared in try Self.prepare(candidates[start ..< end], files: files) {
                try request.emit(["kind": "scanOutcome", "outcome": outcome(prepared, remaining: &remaining)])
            }
            start = end
        }
        return ["kind": "searchSourceScan", "count": candidates.count]
    }

    /// The end of the batch that starts at `start`: its first candidate, then each next one while the batch fits.
    private func batchEnd(from start: Int) -> Int {
        var end = start + 1, bytes = candidates[start].expected.byteCount
        while end < candidates.endIndex, bytes + candidates[end].expected.byteCount <= Self.batchBytes {
            bytes += candidates[end].expected.byteCount
            end += 1
        }
        return end
    }

    /// A batch as its concurrent reads share it. Each read writes only its own result slot, and `files` is not mutated
    /// while the scan runs, because the helper handles one request at a time.
    private struct Batch: @unchecked Sendable {
        let candidates: ArraySlice<Candidate>
        let files: ConfinedFiles
        let results: UnsafeMutableBufferPointer<Result<Prepared, any Error>>
    }

    /// Reads and decodes a batch's candidates concurrently, returning them in candidate order. An error other than a
    /// read failure is thrown when its candidate is reached.
    private static func prepare(_ candidates: ArraySlice<Candidate>, files: ConfinedFiles) throws -> [Prepared] {
        let batch = Batch(candidates: candidates, files: files,
                          results: .allocate(capacity: candidates.count))
        defer { batch.results.deinitialize(); batch.results.deallocate() }
        DispatchQueue.concurrentPerform(iterations: candidates.count) { index in
            let candidate = batch.candidates[batch.candidates.startIndex + index]
            (batch.results.baseAddress! + index).initialize(to: Result { try prepare(candidate, files: batch.files) })
        }
        return try batch.results.map { try $0.get() }
    }

    private static func prepare(_ candidate: Candidate, files: ConfinedFiles) throws -> Prepared {
        let source: ConfinedSource?
        do {
            source = try files.readConfinedSource(
                candidate.root, path: candidate.path, expected: candidate.expected
            ) { try RPCEBinaryProbe.isBinary(path: candidate.path, descriptor: $0) }
        } catch let failure as BridgeFailure {
            let number: Any = failure.number.map { $0 as Any } ?? NSNull()
            return .failed(["kind": "failed", "code": failure.code, "errno": number])
        }
        guard let text = decodedText(source) else { return .skipped }
        return .decoded(text: text, textIdentity: Extraction.identity(Data(text.utf8)).json)
    }

    private func outcome(_ prepared: Prepared, remaining: inout Int) throws -> [String: Any] {
        switch prepared {
        case let .failed(outcome): return outcome
        case .skipped: return ["kind": "skipped"]
        case let .decoded(text, textIdentity):
            let result = try scan(text, limit: remaining)
            let matchingLines = (result["matchingLines"] as? Int) ?? 0
            remaining -= matchingLines
            return ["kind": "decoded", "textIdentity": textIdentity, "result": result,
                    "text": matchingLines > 0 && !countOnly ? text : NSNull()]
        }
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
