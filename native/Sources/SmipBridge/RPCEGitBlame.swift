// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: isolate command construction and stdout parsing from app process ownership.
// Source parser layout is retained; configured CCCC checks remain enabled.
// swiftlint:disable identifier_name opening_brace
import Foundation

struct RPCEGitBlame {
    /// A single line of blame output.
    struct BlameLine {
        let line: Int
        let sha: String
        let author: String
        let dateISO: String
        let content: String
    }

    func arguments(path: String, lineRange: ClosedRange<Int>?) -> [String] {
        var args = [
            "blame",
            // Repository converters are executable programs, not read-only source access.
            "--no-textconv",
            "--line-porcelain"
        ]
        if let range = lineRange {
            args.append("-L")
            args.append("\(range.lowerBound),\(range.upperBound)")
        }
        args.append("--")
        args.append(path)

        return args
    }

    func parseBlameOutput(_ output: String) -> [BlameLine] {
        var results: [BlameLine] = []
        let lines = output.components(separatedBy: "\n")

        var currentSHA: String?
        var currentAuthor: String?
        var currentAuthorTime: String?
        var currentLineNum: Int?
        var i = 0

        while i < lines.count {
            let line = lines[i]

            // First line of a block: <sha> <origLine> <finalLine> [<numLines>]
            if line.count >= 40, !line.hasPrefix("\t") {
                let parts = line.split(separator: " ", maxSplits: 3).map(String.init)
                if parts.count >= 3, parts[0].count == 40 {
                    currentSHA = parts[0]
                    currentLineNum = Int(parts[2])
                }
            } else if line.hasPrefix("author ") {
                currentAuthor = String(line.dropFirst("author ".count))
            } else if line.hasPrefix("author-time ") {
                // Unix timestamp
                if let timestamp = Int(line.dropFirst("author-time ".count)) {
                    let date = Date(timeIntervalSince1970: TimeInterval(timestamp))
                    let formatter = ISO8601DateFormatter()
                    formatter.formatOptions = [.withInternetDateTime]
                    currentAuthorTime = formatter.string(from: date)
                }
            } else if line.hasPrefix("\t") {
                // Content line
                let content = String(line.dropFirst())
                if let sha = currentSHA,
                   let author = currentAuthor,
                   let time = currentAuthorTime,
                   let lineNum = currentLineNum
                {
                    results.append(BlameLine(
                        line: lineNum,
                        sha: String(sha.prefix(7)),
                        author: author,
                        dateISO: time,
                        content: content
                    ))
                }
            }

            i += 1
        }

        return results
    }
}

// swiftlint:enable identifier_name opening_brace
