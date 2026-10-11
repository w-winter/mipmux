// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: consume captured tracked diff outputs; keep execution with the process supervisor.
// swiftlint:disable identifier_name
import Foundation

struct RPCEGitDiffStats {
    typealias UncommittedFile = VCSUncommittedFile

    func parse(numstat: String, nameStatus: String) -> [UncommittedFile] {
        let statsMap = parseNumstatOutput(numstat)
        let statusMap = parseNameStatusOutput(nameStatus)
        var results: [UncommittedFile] = []
        let allPaths = Set(statsMap.keys).union(statusMap.keys)

        for path in allPaths {
            let status = statusMap[path] ?? "M"
            let tuple = statsMap[path]
            let additions = tuple?.0
            let deletions = tuple?.1
            results.append(
                UncommittedFile(
                    path: path,
                    status: status,
                    additions: additions,
                    deletions: deletions
                )
            )
        }

        let keyed = results.map { file in
            (lower: file.path.lowercased(), original: file.path, file: file)
        }
        return keyed.sorted { lhs, rhs in
            if lhs.lower != rhs.lower {
                return lhs.lower < rhs.lower
            }
            return lhs.original < rhs.original
        }.map(\.file)
    }

    /// Parses `git diff --numstat` output into a map of path → (additions, deletions)
    nonisolated func parseNumstatOutput(_ output: String) -> [String: (Int?, Int?)] {
        var map: [String: (Int?, Int?)] = [:]

        for rawLine in output.split(separator: "\n") {
            let parts = rawLine.split(separator: "\t", maxSplits: 2).map(String.init)
            guard parts.count == 3 else { continue }

            let addStr = parts[0]
            let delStr = parts[1]
            let pathRaw = parts[2]
            let path = normalizeRenamedPath(pathRaw)

            let additions = Int(addStr) // nil when "-"
            let deletions = Int(delStr)

            map[path] = (additions, deletions)
        }
        return map
    }

    /// Convert numstat rename formats to the final/new path so they line up with name-status.
    /// Handles:
    ///  - "old/path => new/path"
    ///  - "dir/{old => new}/file.swift"
    nonisolated func normalizeRenamedPath(_ s: String) -> String {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)

        // Brace segment renames: "a/{old => new}/b"
        if trimmed.contains("{"), trimmed.contains("}"), trimmed.contains(" => ") {
            var out = ""
            var i = trimmed.startIndex
            var handledBraceRename = false
            while i < trimmed.endIndex {
                if trimmed[i] == "{", let end = trimmed[i...].firstIndex(of: "}") {
                    let inner = trimmed[trimmed.index(after: i) ..< end]
                    if let sep = inner.range(of: " => ") {
                        handledBraceRename = true
                        out += inner[sep.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
                    } else {
                        out.append("{")
                        out += inner
                        out.append("}")
                    }
                    i = trimmed.index(after: end)
                } else {
                    out.append(trimmed[i])
                    i = trimmed.index(after: i)
                }
            }
            if handledBraceRename {
                return out
            }
        }

        // Simple "old/path => new/path" whole-path rename
        if let arrow = trimmed.range(of: " => ") {
            return String(trimmed[arrow.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return trimmed
    }

    /// Parses `git diff --name-status` lines into a map of path → single-letter status
    nonisolated func parseNameStatusOutput(_ output: String) -> [String: String] {
        var map: [String: String] = [:]

        for rawLine in output.split(separator: "\n") {
            let parts = rawLine
                .split(separator: "\t", omittingEmptySubsequences: false)
                .map(String.init)
            guard !parts.isEmpty else { continue }

            let statusCode = parts[0].trimmingCharacters(in: .whitespaces)

            // Handle rename/copy which provide two paths
            let path: String = if statusCode.hasPrefix("R") || statusCode.hasPrefix("C") {
                // new path is last field
                parts.last ?? ""
            } else {
                parts.count > 1 ? parts[1] : ""
            }

            if !path.isEmpty {
                map[path] = String(statusCode.prefix(1)) // e.g. "M"
            }
        }
        return map
    }
}

// swiftlint:enable identifier_name
