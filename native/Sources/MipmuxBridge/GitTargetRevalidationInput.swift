import Foundation

struct GitTargetRevalidationInput {
    private struct Checkout {
        let path: String
        let repoKey: String
        let repositoryID: String
        let worktreeID: String
        let linked: Bool
    }

    private let checkouts: [Checkout]

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "checkouts"])
        guard let raw = try input.value("checkouts") as? [Any] else { throw BridgeFailure("nativeProtocolError") }
        checkouts = try raw.map { value in
            let fields = try WireObject(
                value,
                keys: ["root", "checkoutRootPath", "repoKey", "repositoryID", "worktreeID", "kind"]
            )
            let kind = try fields.string("kind")
            guard ["canonical", "linkedWorktree"].contains(kind) else { throw BridgeFailure("nativeProtocolError") }
            return try Checkout(path: fields.string("checkoutRootPath"), repoKey: fields.string("repoKey"),
                                repositoryID: fields.string("repositoryID"), worktreeID: fields.string("worktreeID"),
                                linked: kind == "linkedWorktree")
        }
    }

    func render(resolver: SelectedPathVCSResolver) async -> [String: Any] {
        for checkout in checkouts {
            guard let resolved = await resolver.resolve(from: URL(fileURLWithPath: checkout.path)),
                  resolved.backendKind == .git,
                  resolved.rootURL.standardizedFileURL.path == checkout.path,
                  let layout = GitRepositoryLayoutResolver.resolve(atWorkTreeRoot: resolved.rootURL),
                  layout.workTreeRoot.standardizedFileURL.path == checkout.path,
                  layout.isLinkedWorktree == checkout.linked else { return result(false) }
            let repository = GitWorktreeIdentity.repositoryIdentity(commonGitDir: layout.commonDir,
                                                                    mainWorktreeRoot: layout.knownMainWorktreeRoot)
            let worktree = GitWorktreeIdentity.worktreeID(repositoryID: repository.repositoryID, gitDir: layout.gitDir,
                                                          isMain: !layout.isLinkedWorktree, path: layout.workTreeRoot)
            guard repository.repositoryID == checkout.repositoryID, worktree == checkout.worktreeID,
                  GitRepoDescriptor(rootURL: layout.workTreeRoot).repoKey == checkout.repoKey
            else { return result(false) }
        }
        return result(true)
    }

    private func result(_ valid: Bool) -> [String: Any] {
        ["kind": "gitTargetValidation", "valid": valid]
    }
}
