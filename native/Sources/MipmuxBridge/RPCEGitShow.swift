// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: separate source command construction and metadata parsing from process execution.
import Foundation

struct RPCEGitShow {
    struct CommitInfo {
        let sha: String
        let shortSHA: String
        let author: String
        let dateISO: String
        let message: String
    }

    func metadataArguments() -> [String] {
        [
            "show",
            "-s",
            "--date=iso-strict",
            "--format=%H%x09%h%x09%an%x09%ad%x09%B",
            "--no-ext-diff",
            "--no-textconv",
            "--color=never"
        ]
    }

    func parseMetadata(_ stdout: String) throws -> CommitInfo {
        let parts = stdout.split(separator: "\t", maxSplits: 4).map(String.init)
        guard parts.count >= 5 else {
            throw RPCEGitShowError(message: "Unexpected git show output format")
        }

        return CommitInfo(
            sha: parts[0],
            shortSHA: parts[1],
            author: parts[2],
            dateISO: parts[3],
            message: parts[4].trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    func diffArguments(kind: String?, contextLines: Int?, detectRenames: Bool) -> [String] {
        var args = ["diff"]
        if let kind { args.append(kind) }
        if let contextLines {
            args.append("--unified=\(contextLines)")
        }
        if detectRenames {
            args.append("-M")
        }
        args.append("--no-ext-diff")
        args.append("--color=never")
        // Repository converters are executable programs, not read-only source access.
        args.append("--no-textconv")
        return args
    }
}

struct RPCEGitShowError: Error {
    let message: String
}
