import Foundation

struct ReadTextInput {
    private let prepared: WorkspaceInteractiveReadPreparedContent
    private let startLine1Based: Int?
    private let limit: Int?

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "text", "start_line", "offset", "limit"])
        let bytes = try JSONSerialization.data(withJSONObject: input.fields)
        let args = try JSONDecoder().decode([String: SelectionJSONValue].self, from: bytes)
        let startLineFromInteger = args["start_line"]?.intValue
        let offsetFromInteger = args["offset"]?.intValue
        let startLineFromString = args["start_line"]?.stringValue.flatMap(Int.init)
        let offsetFromString = args["offset"]?.stringValue.flatMap(Int.init)
        startLine1Based = startLineFromInteger ?? offsetFromInteger ?? startLineFromString ?? offsetFromString
        limit = args["limit"]?.intValue ?? args["limit"]?.stringValue.flatMap(Int.init)
        prepared = try WorkspaceInteractiveReadProcessor.prepare(input.text("text"))
    }

    func render() -> [String: Any] {
        do {
            let slice = try WorkspaceInteractiveReadProcessor.slice(
                prepared,
                startLine1Based: startLine1Based,
                lineCount: limit
            )
            return ["kind": "readTextSlice", "content": slice.content, "totalLines": slice.totalLines,
                    "firstLine": slice.firstLine, "lastLine": slice.lastLine,
                    "returnedLineCount": slice.returnedLineCount,
                    "message": slice.startExceededFileLength ? "Requested start_line exceeds file length." : NSNull(),
                    "lines": lines(in: slice)]
        } catch WorkspaceInteractiveReadRangeError.limitWithNegativeStart {
            return ["kind": "readTextRangeError", "code": "limitWithNegativeStart",
                    // swiftlint:disable:next line_length
                    "message": "limit parameter is not allowed with negative start_line. Use start_line=-N to read the last N lines."]
        } catch WorkspaceInteractiveReadRangeError.zeroStart {
            return ["kind": "readTextRangeError", "code": "zeroStart",
                    "message": "start_line must be positive (1-based) or negative (tail-like behavior)"]
        } catch { preconditionFailure("Unexpected interactive read range error") }
    }

    private func lines(in slice: WorkspaceInteractiveReadSlice) -> [[String: Any]] {
        var offset = 0
        var lines: [[String: Any]] = []
        for (index, text) in prepared.linesWithEndings.enumerated() {
            defer { offset += text.utf8.count }
            if index + 1 >= slice.firstLine, index + 1 <= slice.lastLine {
                lines.append(["number": index + 1, "offset": offset, "length": text.utf8.count, "text": text])
            }
        }
        return lines
    }
}
