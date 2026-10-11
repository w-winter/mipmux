// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: isolate command construction and stdout parsing from app process ownership.
// Source parser identifiers are retained; configured CCCC checks remain enabled.
// swiftlint:disable identifier_name
import Foundation

struct RPCEGitLog {
    /// Summary of a commit for log output.
    struct CommitSummary {
        let sha: String
        let shortSHA: String
        let author: String
        let dateISO: String
        let message: String
        let filesChanged: Int
        let insertions: Int
        let deletions: Int
    }

    func arguments(count: Int, path: String?) -> [String] {
        // Use a custom format with a separator to parse commits
        // Format: __C__<sha>\t<short>\t<author>\t<date>\t<subject>
        // Followed by --numstat lines
        var args = [
            "log",
            "-n", "\(count)",
            "--date=iso-strict",
            "--pretty=format:__C__%H%x09%h%x09%an%x09%ad%x09%s",
            "--numstat",
            "--no-ext-diff",
            "--no-textconv",
            "--color=never"
        ]
        if let path, !path.isEmpty {
            args.append("--")
            args.append(path)
        }

        return args
    }

    func parseLogSummaries(_ output: String) -> [CommitSummary] {
        var results: [CommitSummary] = []
        let blocks = output.components(separatedBy: "__C__").filter { !$0.isEmpty }

        for block in blocks {
            let lines = block.components(separatedBy: "\n")
            guard let headerLine = lines.first else { continue }

            let headerParts = headerLine.split(separator: "\t", maxSplits: 4).map(String.init)
            guard headerParts.count >= 5 else { continue }

            let sha = headerParts[0]
            let shortSHA = headerParts[1]
            let author = headerParts[2]
            let dateISO = headerParts[3]
            let message = headerParts[4]

            // Parse numstat lines for this commit
            var filesChanged = 0
            var insertions = 0
            var deletions = 0

            for i in 1 ..< lines.count {
                let line = lines[i].trimmingCharacters(in: .whitespaces)
                guard !line.isEmpty else { continue }
                let parts = line.split(separator: "\t", maxSplits: 2).map(String.init)
                guard parts.count >= 2 else { continue }

                filesChanged += 1
                if let adds = Int(parts[0]) {
                    insertions += adds
                }
                if let dels = Int(parts[1]) {
                    deletions += dels
                }
            }

            results.append(CommitSummary(
                sha: sha,
                shortSHA: shortSHA,
                author: author,
                dateISO: dateISO,
                message: message,
                filesChanged: filesChanged,
                insertions: insertions,
                deletions: deletions
            ))
        }

        return results
    }
}

// swiftlint:enable identifier_name
