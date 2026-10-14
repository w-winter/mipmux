// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

// MARK: - Git Worktree Porcelain Parser

struct GitWorktreePorcelainRecord: Codable, Equatable {
    var path: String
    var head: String?
    var branch: String?
    var isDetached: Bool
    var isBare: Bool
    var isLocked: Bool
    var lockReason: String?
    var isPrunable: Bool
    var prunableReason: String?

    init(
        path: String,
        head: String? = nil,
        branch: String? = nil,
        isDetached: Bool,
        isBare: Bool,
        isLocked: Bool,
        lockReason: String? = nil,
        isPrunable: Bool,
        prunableReason: String? = nil
    ) {
        self.path = path
        self.head = head
        self.branch = branch
        self.isDetached = isDetached
        self.isBare = isBare
        self.isLocked = isLocked
        self.lockReason = lockReason
        self.isPrunable = isPrunable
        self.prunableReason = prunableReason
    }
}

enum GitWorktreePorcelainFormat {
    case nulTerminated
    case newlineTerminated
}

enum GitWorktreePorcelainParser {
    static func parse(_ output: String, format: GitWorktreePorcelainFormat) throws -> [GitWorktreePorcelainRecord] {
        switch format {
        case .nulTerminated:
            try parseTokens(output.split(separator: "\0", omittingEmptySubsequences: false).map(String.init))
        case .newlineTerminated:
            try parseTokens(output.components(separatedBy: .newlines))
        }
    }

    private static func parseTokens(_ tokens: [String]) throws -> [GitWorktreePorcelainRecord] {
        var records: [GitWorktreePorcelainRecord] = []
        var builder: GitWorktreePorcelainRecordBuilder?

        for rawToken in tokens {
            guard !rawToken.isEmpty else {
                if let current = builder {
                    try records.append(current.finish())
                    builder = nil
                }
                continue
            }

            let (key, value) = splitAttribute(rawToken)
            if key == "worktree" {
                if let current = builder {
                    try records.append(current.finish())
                }
                builder = GitWorktreePorcelainRecordBuilder(path: value)
                continue
            }

            guard builder != nil else {
                throw VCSError.parseError(message: "worktree porcelain attribute appeared before worktree path: \(key)")
            }
            try builder?.apply(key: key, value: value)
        }

        if let current = builder {
            try records.append(current.finish())
        }
        return records
    }

    private static func splitAttribute(_ line: String) -> (key: String, value: String) {
        guard let spaceIndex = line.firstIndex(of: " ") else {
            return (line, "")
        }
        let key = String(line[..<spaceIndex])
        let valueStart = line.index(after: spaceIndex)
        return (key, String(line[valueStart...]))
    }
}

private struct GitWorktreePorcelainRecordBuilder {
    var path: String
    var head: String?
    var branch: String?
    var isDetached = false
    var isBare = false
    var isLocked = false
    var lockReason: String?
    var isPrunable = false
    var prunableReason: String?

    mutating func apply(key: String, value: String) throws {
        switch key {
        case "HEAD":
            head = value.isEmpty ? nil : value
        case "branch":
            branch = normalizeBranch(value)
        case "detached":
            isDetached = true
        case "bare":
            isBare = true
        case "locked":
            isLocked = true
            lockReason = value.isEmpty ? nil : value
        case "prunable":
            isPrunable = true
            prunableReason = value.isEmpty ? nil : value
        default:
            // Preserve forward compatibility with future porcelain attributes.
            break
        }
    }

    func finish() throws -> GitWorktreePorcelainRecord {
        guard !path.isEmpty else {
            throw VCSError.parseError(message: "worktree porcelain record is missing a path")
        }
        return GitWorktreePorcelainRecord(
            path: path,
            head: head,
            branch: branch,
            isDetached: isDetached,
            isBare: isBare,
            isLocked: isLocked,
            lockReason: lockReason,
            isPrunable: isPrunable,
            prunableReason: prunableReason
        )
    }

    private func normalizeBranch(_ value: String) -> String? {
        guard !value.isEmpty else { return nil }
        let prefix = "refs/heads/"
        if value.hasPrefix(prefix) {
            return String(value.dropFirst(prefix.count))
        }
        return value
    }
}
