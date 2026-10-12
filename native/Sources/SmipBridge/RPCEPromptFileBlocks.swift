// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: extract formatting into an executable-local owner; expose its entry point.
import Foundation

enum RPCEPromptFileBlocks {
    @inline(__always)
    static func codeFenceStart(for fileName: String) -> String {
        let ext = URL(fileURLWithPath: fileName).pathExtension // "swift", "m", ""
        return ext.isEmpty ? "```" : "```\(ext)"
    }

    private static func renderFullFileBlock(selectedPath: String, startFence: String, content: String) -> String {
        let endFence = "```"
        return """
        File: \(selectedPath)
        \(startFence)
        \(content)
        \(endFence)
        """
    }

    private static func renderSliceFileBlock(
        selectedPath: String, startFence: String, segments: [WorkspaceSliceSegment]
    ) -> String {
        let endFence = "```"
        var sliceLines = ["File: \(selectedPath)"]
        for (index, segment) in segments.enumerated() {
            let label = formatRange(segment.range)
            if let desc = segment.range.description, !desc.isEmpty {
                sliceLines.append("(lines \(label): \(desc))")
            } else {
                sliceLines.append("(lines \(label))")
            }
            sliceLines.append(startFence)
            sliceLines.append(segment.text)
            sliceLines.append(endFence)
            if index != segments.count - 1 {
                sliceLines.append("")
            }
        }
        return sliceLines.joined(separator: "\n")
    }

    static func renderFileBlock(
        selectedPath: String,
        startFence: String,
        content _: String,
        assembly: WorkspaceSliceAssembly
    ) -> String {
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
