// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: capture command arguments; execute through the existing process supervisor.
import Foundation

struct RPCEGitDiffCommands {
    struct Commands {
        let numstat: [String]
        let nameStatus: [String]
        let patch: [String]
    }

    private enum DiffStatKind {
        case numstat
        case nameStatus
    }

    // swiftlint:disable cyclomatic_complexity
    private func diffArgs(
        for compare: GitDiffCompareSpec,
        kind: DiffStatKind
    ) -> (argsPrefix: [String], refArg: String?) {
        var argsPrefix = ["diff"]
        switch compare {
        case .staged:
            argsPrefix.append("--cached")
        case .stagedMergeBase:
            argsPrefix.append("--cached")
            argsPrefix.append("--merge-base")
        case .uncommittedMergeBase:
            argsPrefix.append("--merge-base")
        default:
            break
        }
        switch kind {
        case .numstat:
            argsPrefix.append("--numstat")
        case .nameStatus:
            argsPrefix.append("--name-status")
        }

        let refArg: String? = switch compare {
        case let .uncommitted(base):
            base
        case let .uncommittedMergeBase(base):
            base
        case let .staged(base):
            base
        case let .stagedMergeBase(base):
            base
        case .unstaged:
            nil
        case let .revspec(revspec):
            revspec
        }
        return (argsPrefix, refArg)
    }

    // swiftlint:enable cyclomatic_complexity

    func arguments(compare: GitDiffCompareSpec, contextLines: Int, detectRenames: Bool) -> Commands {
        let (numstatPrefix, reference) = diffArgs(for: compare, kind: .numstat)
        let (nameStatusPrefix, _) = diffArgs(for: compare, kind: .nameStatus)
        func command(_ prefix: [String], _ context: Int?) -> [String] {
            var args = prefix + RPCEGitShow().diffArguments(
                kind: nil,
                contextLines: context,
                detectRenames: detectRenames
            ).dropFirst()
            if let reference, !reference.isEmpty { args.append(reference) }
            return args
        }
        return Commands(numstat: command(numstatPrefix, nil), nameStatus: command(nameStatusPrefix, nil),
                        patch: command(Array(numstatPrefix.dropLast()), contextLines))
    }

    nonisolated static func normalizeBatchedUntrackedDiffPaths(_ output: String) -> String {
        output.split(separator: "\n", omittingEmptySubsequences: false).map { line in
            let text = String(line)
            guard text.hasPrefix("diff --git ")
                || text.hasPrefix("--- ")
                || text.hasPrefix("+++ ")
                || text.hasPrefix("Binary files ")
            else { return text }
            return text
                .replacingOccurrences(of: "1/./", with: "a/")
                .replacingOccurrences(of: "2/./", with: "b/")
                .replacingOccurrences(of: "a/./", with: "a/")
                .replacingOccurrences(of: "b/./", with: "b/")
                .replacingOccurrences(of: "\"1/./", with: "\"a/")
                .replacingOccurrences(of: "\"2/./", with: "\"b/")
                .replacingOccurrences(of: "\"a/./", with: "\"a/")
                .replacingOccurrences(of: "\"b/./", with: "\"b/")
        }.joined(separator: "\n")
    }
}
