import Foundation

struct GitPublicationMetadataInput {
    private let repoRoot: String
    private static let commitGraphLines = 20

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "repoRoot"])
        repoRoot = try fields.string("repoRoot")
    }

    func render() throws -> [String: Any] {
        let worktree = RPCEGitSnapshotWorktreeMetadata().metadata(for: repoRoot)
        let metadata: [String: Any]? = worktree.map { value in
            ["isWorktree": value.isWorktree, "worktreeName": value.worktreeName as Any? ?? NSNull(),
             "worktreeRoot": value.worktreeRoot as Any? ?? NSNull(),
             "mainWorktreeRoot": value.mainWorktreeRoot as Any? ?? NSNull(),
             "commonGitDir": value.commonGitDir as Any? ?? NSNull()]
        }
        return ["kind": "gitPublicationMetadata",
                "graphArguments": [
                    "log",
                    "--graph",
                    "--decorate",
                    "--oneline",
                    "--color=never",
                    "-n",
                    String(Self.commitGraphLines)
                ],
                "worktree": metadata as Any? ?? NSNull()]
    }
}
