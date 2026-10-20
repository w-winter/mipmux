// Source read-slice body is retained; configured CCCC limits remain enabled.
// swiftlint:disable function_body_length
// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: retain synchronous text preparation and slicing; omit desktop cache and task scheduling.
import Foundation

struct WorkspaceInteractiveReadPreparedContent: Equatable {
    let linesWithEndings: [String]

    var totalLines: Int {
        linesWithEndings.count
    }
}

struct WorkspaceInteractiveReadSlice: Equatable {
    let content: String
    let totalLines: Int
    let firstLine: Int
    let lastLine: Int
    let returnedLineCount: Int
    let startExceededFileLength: Bool
}

enum WorkspaceInteractiveReadRangeError: Error, Equatable {
    case limitWithNegativeStart
    case zeroStart
}

enum WorkspaceInteractiveReadProcessor {
    static func prepare(_ content: String) -> WorkspaceInteractiveReadPreparedContent {
        WorkspaceInteractiveReadPreparedContent(
            linesWithEndings: String.splitContentPreservingAllLineEndings(content).map { pair in
                pair.line + pair.ending
            }
        )
    }

    static func slice(
        _ prepared: WorkspaceInteractiveReadPreparedContent,
        startLine1Based: Int?,
        lineCount: Int?
    ) throws -> WorkspaceInteractiveReadSlice {
        if let startLine1Based {
            if startLine1Based < 0, lineCount != nil {
                throw WorkspaceInteractiveReadRangeError.limitWithNegativeStart
            }
            if startLine1Based == 0 {
                throw WorkspaceInteractiveReadRangeError.zeroStart
            }
        }

        let total = prepared.totalLines
        let first: Int
        let lastExclusive: Int
        if let startLine1Based, startLine1Based < 0 {
            let tailCount = startLine1Based == Int.min ? Int.max : abs(startLine1Based)
            first = total - min(total, tailCount)
            lastExclusive = total
        } else {
            let start = max(0, (startLine1Based ?? 1) - 1)
            first = start
            lastExclusive = if let lineCount, lineCount >= 0 {
                if start >= total {
                    total
                } else {
                    start + min(lineCount, total - start)
                }
            } else {
                total
            }
        }

        guard first < total || total == 0 else {
            return WorkspaceInteractiveReadSlice(
                content: "",
                totalLines: total,
                firstLine: max(1, first + 1),
                lastLine: total,
                returnedLineCount: 0,
                startExceededFileLength: true
            )
        }

        let content = total == 0
            ? ""
            : prepared.linesWithEndings[first ..< lastExclusive].joined()
        let shownFirst = total == 0 ? 0 : first + 1
        let shownLast = total == 0 ? 0 : lastExclusive
        return WorkspaceInteractiveReadSlice(
            content: content,
            totalLines: total,
            firstLine: shownFirst,
            lastLine: shownLast,
            returnedLineCount: max(0, shownLast - shownFirst + (shownLast == 0 ? 0 : 1)),
            startExceededFileLength: false
        )
    }
}

// swiftlint:enable function_body_length
