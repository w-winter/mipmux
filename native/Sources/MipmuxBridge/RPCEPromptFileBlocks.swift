// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: executable-local owner and raw-body span capture during source line emission.
import Foundation

enum FileBlockLine {
    case syntax(String)
    case body(String)
}

struct CapturedFileBlock {
    let text: String
    let bodySpans: [(offset: Int, length: Int)]

    init(lines: [FileBlockLine]) {
        var text = ""
        var byteOffset = 0
        var spans: [(offset: Int, length: Int)] = []
        for (index, line) in lines.enumerated() {
            if index > 0 { text += "\n"; byteOffset += 1 }
            switch line {
            case let .syntax(value): text += value; byteOffset += value.utf8.count
            case let .body(value):
                let length = value.utf8.count
                spans.append((byteOffset, length))
                text += value
                byteOffset += length
            }
        }
        self.text = text
        bodySpans = spans
    }
}

enum RPCEPromptFileBlocks {
    @inline(__always)
    static func codeFenceStart(for fileName: String) -> String {
        let ext = URL(fileURLWithPath: fileName).pathExtension // "swift", "m", ""
        return ext.isEmpty ? "```" : "```\(ext)"
    }

    private static func renderFullFileBlock(
        selectedPath: String, startFence: String, content: String
    ) -> CapturedFileBlock {
        let endFence = "```"
        return CapturedFileBlock(lines: [
            .syntax("File: \(selectedPath)"), .syntax(startFence), .body(content), .syntax(endFence)
        ])
    }

    private static func renderSliceFileBlock(
        selectedPath: String, startFence: String, segments: [WorkspaceSliceSegment]
    ) -> CapturedFileBlock {
        let endFence = "```"
        var sliceLines: [FileBlockLine] = [.syntax("File: \(selectedPath)")]
        for (index, segment) in segments.enumerated() {
            let label = formatRange(segment.range)
            if let desc = segment.range.description, !desc.isEmpty {
                sliceLines.append(.syntax("(lines \(label): \(desc))"))
            } else {
                sliceLines.append(.syntax("(lines \(label))"))
            }
            sliceLines.append(.syntax(startFence))
            sliceLines.append(.body(segment.text))
            sliceLines.append(.syntax(endFence))
            if index != segments.count - 1 {
                sliceLines.append(.syntax(""))
            }
        }
        return CapturedFileBlock(lines: sliceLines)
    }

    static func renderFileBlock(
        selectedPath: String,
        startFence: String,
        content _: String,
        assembly: WorkspaceSliceAssembly
    ) -> CapturedFileBlock {
        if assembly.isFullFile {
            return renderFullFileBlock(
                selectedPath: selectedPath, startFence: startFence, content: assembly.combinedText
            )
        }
        return renderSliceFileBlock(selectedPath: selectedPath, startFence: startFence, segments: assembly.segments)
    }

    private static func formatRange(_ range: LineRange) -> String {
        range.start == range.end ? "\(range.start)" : "\(range.start)-\(range.end)"
    }
}
