import Foundation

struct FileBlockInput {
    private let selectedPath: String
    private let fileName: String
    private let content: String
    private let ranges: [LineRange]?

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "selectedPath", "fileName", "content", "ranges"])
        selectedPath = try input.string("selectedPath")
        fileName = try input.string("fileName")
        content = try input.text("content")
        let rawRanges = try input.value("ranges")
        if rawRanges is NSNull {
            ranges = nil
        } else if let values = rawRanges as? [Any] {
            ranges = try values.map { try LineRange(wire: $0) }
        } else { throw BridgeFailure("nativeProtocolError") }
    }

    func render() -> [String: Any] {
        let assembly = SliceAssemblyBuilder.build(from: content, ranges: ranges)
        let text = RPCEPromptFileBlocks.renderFileBlock(
            selectedPath: selectedPath, startFence: RPCEPromptFileBlocks.codeFenceStart(for: fileName),
            content: content, assembly: assembly
        )
        let segments = assembly.segments.map { segment -> [String: Any] in
            ["start": segment.range.start, "end": segment.range.end,
             "description": segment.range.description.map { $0 as Any } ?? NSNull(), "text": segment.text]
        }
        return ["kind": "fileBlock", "text": text, "segments": segments,
                "combinedText": assembly.combinedText, "totalLines": assembly.totalLines,
                "detectedLineEnding": assembly.detectedLineEnding, "isFullFile": assembly.isFullFile]
    }
}
