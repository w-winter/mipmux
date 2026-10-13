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

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "roots", "paths"])
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

    func render() throws -> [String: Any] {
        guard !paths.isEmpty else { return ["kind": "gitTarget", "state": "deferred"] }
        let ownership = try ReviewGitSelectedPathOwnershipResolver().resolve(
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
