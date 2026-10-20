import Foundation

enum VCSBackendKind: String { case git, jujutsu }
struct VCSResolvedRepo {
    let rootURL: URL
    let backendKind: VCSBackendKind
}

enum FrozenVisibleGitCheckoutKind: Equatable, Hashable { case canonical, linkedWorktree }
enum ReviewGitPathIssue: Equatable {
    case unresolvedSelection(displayPath: String)
    case noRepository(displayPath: String)
    case unsupportedBackend(displayPath: String, backendKind: VCSBackendKind)
    case invalidGitLayout(displayPath: String)
}

struct WorkspaceSelectedGitPathResolution {
    let paths: [String]
    let unresolvedCandidates: [String]
}

struct GitTargetInput {
    struct Root {
        let name: String
        let path: String
    }

    struct Checkout: Hashable {
        let root: String
        let checkoutRootPath: String
        let repoKey: String
        let repositoryID: String
        let worktreeID: String
        let kind: FrozenVisibleGitCheckoutKind

        var json: [String: Any] {
            ["root": root, "checkoutRootPath": checkoutRootPath, "repoKey": repoKey,
             "repositoryID": repositoryID, "worktreeID": worktreeID,
             "kind": kind == .linkedWorktree ? "linkedWorktree" : "canonical"]
        }

        var identityKey: String {
            [repoKey, repositoryID, worktreeID, checkoutRootPath].joined(separator: "\u{1f}")
        }
    }

    private let roots: [Root]
    private let paths: [String]
    private let completeRoot: Bool

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "roots", "paths"])
        completeRoot = try input.string("kind") == "resolveCompleteGitTarget"
        guard let rawRoots = try input.value("roots") as? [Any],
              let rawPaths = try input.value("paths") as? [Any] else { throw BridgeFailure("nativeProtocolError") }
        roots = try rawRoots.map { value in
            let root = try WireObject(value, keys: ["name", "path"])
            return try Root(name: root.string("name"), path: root.string("path"))
        }
        paths = try rawPaths.map { value in
            guard let path = value as? String, path.hasPrefix("/"), !path.contains("\0") else {
                throw BridgeFailure("nativeProtocolError")
            }
            return path
        }
    }

    func render(resolver: SelectedPathVCSResolver) async throws -> [String: Any] {
        if completeRoot { return try await resolveCompleteRoot(resolver: resolver) }
        guard !paths.isEmpty else { return ["kind": "gitTarget", "state": "deferred"] }
        let paths = try Self.normalizedSelectionPaths(paths, roots: roots.map(\.path))
        let ownershipResolver = ReviewGitSelectedPathOwnershipResolver(dependencies: .live(resolver: resolver))
        let ownership = try await ownershipResolver.resolve(
            WorkspaceSelectedGitPathResolution(paths: paths, unresolvedCandidates: []),
            displayContext: ReviewGitDisplayContext(roots: roots.map { root in
                ReviewGitDisplayRoot(
                    logicalRootPath: root.path,
                    logicalRootName: root.name,
                    physicalRootPath: root.path
                )
            })
        )
        guard ownership.pathIssues.isEmpty else { return unavailable(
            "nonGitSelection",
            count: ownership.pathIssues.count
        ) }
        var checkouts: [Checkout] = []
        for group in ownership.checkouts {
            // RPCE makeTarget chooses one longest root containing all paths in this checkout group.
            let canonicalPaths = group.selectedPaths.map(Self.canonicalPath)
            let matching = roots.filter { root in
                let rootPath = Self.canonicalPath(root.path)
                return canonicalPaths.allSatisfy { StandardizedPath.isDescendant($0, of: rootPath) }
            }
            let longest = matching.map { Self.canonicalPath($0.path).count }.max()
            let mostSpecific = matching.filter { Self.canonicalPath($0.path).count == longest }
            guard mostSpecific.count == 1, let root = mostSpecific.first else { return unavailable(
                "ambiguousOwnership",
                count: 0
            ) }
            checkouts.append(Checkout(root: root.name, checkoutRootPath: Self.canonicalPath(group.checkoutRootPath),
                                      repoKey: group.repoKey, repositoryID: group.repositoryID,
                                      worktreeID: group.worktreeID, kind: group.kind))
        }
        let targets = Dictionary(grouping: checkouts, by: \.identityKey)
            .compactMap { _, values in Set(values).count == 1 ? values.first : nil }
            .sorted { lhs, rhs in
                if lhs.root != rhs.root { return lhs.root < rhs.root }
                if lhs.repoKey != rhs.repoKey { return lhs.repoKey < rhs.repoKey }
                if lhs.repositoryID != rhs.repositoryID { return lhs.repositoryID < rhs.repositoryID }
                return lhs.worktreeID < rhs.worktreeID
            }
        guard !targets.isEmpty else { return unavailable("emptySelection", count: 0) }
        let primary = paths.first.flatMap { path in
            targets.first(where: { StandardizedPath.isDescendant(path, of: $0.checkoutRootPath) })
        } ?? targets[0]
        return ["kind": "gitTarget", "state": "available", "checkouts": targets.map(\.json), "primary": primary.json]
    }

    private func unavailable(_ reason: String, count: Int) -> [String: Any] {
        ["kind": "gitTarget", "state": "unavailable", "reason": reason, "count": count]
    }

    private func resolveCompleteRoot(resolver: SelectedPathVCSResolver) async throws -> [String: Any] {
        guard roots.count == 1, paths.count == 1, let root = roots.first, paths[0] == root.path else {
            throw BridgeFailure("nativeProtocolError")
        }
        guard let resolved = await resolver.resolve(from: URL(fileURLWithPath: root.path)),
              resolved.backendKind == .git,
              let layout = GitRepositoryLayoutResolver.resolve(atWorkTreeRoot: resolved.rootURL)
        else {
            return unavailable("nonGitSelection", count: 1)
        }
        let repository = GitWorktreeIdentity.repositoryIdentity(commonGitDir: layout.commonDir,
                                                                mainWorktreeRoot: layout.knownMainWorktreeRoot)
        let checkout = Checkout(root: root.name, checkoutRootPath: layout.workTreeRoot.standardizedFileURL.path,
                                repoKey: GitRepoDescriptor(rootURL: layout.workTreeRoot).repoKey,
                                repositoryID: repository.repositoryID,
                                worktreeID: GitWorktreeIdentity.worktreeID(
                                    repositoryID: repository.repositoryID,
                                    gitDir: layout.gitDir,
                                    isMain: !layout.isLinkedWorktree,
                                    path: layout.workTreeRoot,
                                ),
                                kind: layout.isLinkedWorktree ? .linkedWorktree : .canonical)
        return ["kind": "gitTarget", "state": "available", "checkouts": [checkout.json], "primary": checkout.json]
    }

    static func normalizedSelectionPaths(_ paths: [String], roots: [String]) throws -> [String] {
        try paths.map { path in
            guard let root = roots.filter({ StandardizedPath.isDescendant(path, of: $0) })
                .max(by: { $0.count < $1.count }) else { throw BridgeFailure("nativeProtocolError") }
            let relative = String(path.dropFirst(root.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            return StandardizedPath.join(
                standardizedRoot: StandardizedPath.absolute(root), standardizedRelativePath: relative
            )
        }
    }

    /// Pinned GitRepoRootAuthorization.canonicalPath; hash inputs use their separate source normalization.
    private static func canonicalPath(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        let expanded: String = if trimmed.hasPrefix("~") {
            (trimmed as NSString).expandingTildeInPath
        } else {
            trimmed
        }
        let standardized = (expanded as NSString).standardizingPath
        let resolved = URL(fileURLWithPath: standardized).resolvingSymlinksInPath().path
        return (resolved as NSString).standardizingPath
    }
}
