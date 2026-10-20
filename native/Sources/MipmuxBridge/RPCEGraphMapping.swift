// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: immutable headless data bindings and private phases; retained policy and output.
// Preserve source identifiers, DTO nesting and copied algorithm layout.
// swiftlint:disable cyclomatic_complexity function_body_length line_length identifier_name
import Foundation

struct RPCEGraphMapping {
    func mapCodemapStructureRoot(
        _ raw: WorkspaceCodemapGraphStructureRootResult,
        rootName: String,
        seedPathsByFileID: [UUID: String]
    ) -> WorkspaceCodemapStructureRootResult {
        func logicalPath(fileID: UUID, relativePath: String?) -> String {
            if let seedPath = seedPathsByFileID[fileID] { return seedPath }
            guard let relativePath,
                  let path = WorkspaceCodemapLogicalPresentationPath(
                      rootDisplayName: rootName,
                      standardizedRelativePath: relativePath
                  )
            else { return rootName }
            return path.displayPath
        }
        let nodePaths = Dictionary(uniqueKeysWithValues: raw.nodes.map {
            ($0.fileID, logicalPath(fileID: $0.fileID, relativePath: $0.standardizedRelativePath))
        })
        return WorkspaceCodemapStructureRootResult(
            rootEpoch: raw.rootEpoch,
            rootDisplayName: rootName,
            status: raw.status,
            coverage: raw.coverage,
            updatesPending: raw.updatesPending,
            seeds: raw.seeds.map {
                WorkspaceCodemapStructureSeedResult(
                    fileID: $0.fileID,
                    path: logicalPath(fileID: $0.fileID, relativePath: $0.standardizedRelativePath),
                    state: $0.state
                )
            },
            nodes: raw.nodes.map {
                WorkspaceCodemapStructureNodeResult(
                    fileID: $0.fileID,
                    path: nodePaths[$0.fileID] ?? rootName,
                    depth: $0.depth,
                    isSeed: $0.isSeed,
                    reachedBy: $0.reachedBy
                )
            },
            edges: raw.edges.compactMap {
                guard let from = nodePaths[$0.sourceFileID], let to = nodePaths[$0.targetFileID] else { return nil }
                return WorkspaceCodemapStructureEdgeResult(
                    fromPath: from,
                    toPath: to,
                    symbols: $0.symbols,
                    ambiguous: $0.ambiguous
                )
            },
            unresolved: raw.unresolved.compactMap {
                guard let from = nodePaths[$0.sourceFileID] else { return nil }
                return WorkspaceCodemapStructureUnresolvedResult(
                    fromPath: from,
                    name: $0.referencedName,
                    reason: $0.reason
                )
            },
            truncation: raw.truncation,
            issues: raw.issues.map {
                codemapStructureIssueRecord(
                    $0,
                    path: { fileID in
                        logicalPath(
                            fileID: fileID,
                            relativePath: raw.seeds.first(where: { $0.fileID == fileID })?.standardizedRelativePath
                        )
                    }
                )
            },
            receipt: raw.receipt
        )
    }

    private func codemapStructureIssueRecord(
        _ issue: WorkspaceCodemapGraphStructureIssue,
        path: (UUID) -> String
    ) -> WorkspaceCodemapStructureIssueRecord {
        switch issue {
        case .emptySeeds:
            .init(code: "empty_seeds", phase: "seed_resolution", path: nil, retryable: false, retryAfterMilliseconds: nil, attempted: nil, limit: nil, message: "No usable seed files were supplied.")
        case .updatesPending:
            .init(code: "updates_pending", phase: "graph_snapshot", path: nil, retryable: true, retryAfterMilliseconds: 100, attempted: nil, limit: nil, message: "The committed graph is usable but newer updates are pending.")
        case .watcherGapReconciling:
            .init(code: "watcher_gap_reconciling", phase: "graph_snapshot", path: nil, retryable: true, retryAfterMilliseconds: 100, attempted: nil, limit: nil, message: "The root is reconciling a watcher gap; committed graph data remains usable.")
        case .indexing:
            .init(code: "graph_indexing", phase: "graph_snapshot", path: nil, retryable: true, retryAfterMilliseconds: 100, attempted: nil, limit: nil, message: "The root graph is still indexing.")
        case let .seedPending(fileID):
            .init(code: "seed_pending", phase: "graph_snapshot", path: path(fileID), retryable: true, retryAfterMilliseconds: 100, attempted: nil, limit: nil, message: "The seed has not contributed to the committed graph yet.")
        case let .seedNotIndexed(fileID):
            .init(code: "seed_not_indexed", phase: "graph_snapshot", path: path(fileID), retryable: false, retryAfterMilliseconds: nil, attempted: nil, limit: nil, message: "The seed is not indexed in the committed graph.")
        case let .seedExcluded(fileID):
            .init(code: "seed_excluded", phase: "graph_snapshot", path: path(fileID), retryable: false, retryAfterMilliseconds: nil, attempted: nil, limit: nil, message: "The seed is excluded from codemap indexing.")
        case let .seedFenced(fileID):
            .init(code: "seed_fenced", phase: "graph_revalidation", path: path(fileID), retryable: false, retryAfterMilliseconds: nil, attempted: nil, limit: nil, message: "The seed crossed a destructive safety fence.")
        case .sizeLimit:
            .init(code: "graph_size_limit", phase: "graph_traversal", path: nil, retryable: false, retryAfterMilliseconds: nil, attempted: nil, limit: nil, message: "Graph output was deterministically truncated to fit the requested output size.")
        case .deadline:
            .init(code: "graph_deadline", phase: "graph_traversal", path: nil, retryable: true, retryAfterMilliseconds: 100, attempted: nil, limit: nil, message: "The fixed graph traversal deadline was reached; partial data remains usable.")
        case .graphRevoked:
            .init(code: "graph_revoked", phase: "graph_snapshot", path: nil, retryable: false, retryAfterMilliseconds: nil, attempted: nil, limit: nil, message: "The root-local committed graph is unavailable.")
        case .graphPending:
            .init(code: "graph_indexing", phase: "graph_snapshot", path: nil, retryable: true, retryAfterMilliseconds: 100, attempted: nil, limit: nil, message: "No committed graph snapshot is available yet.")
        }
    }

    func codemapRootEpochPrecedes(
        _ lhs: WorkspaceCodemapRootEpoch,
        _ rhs: WorkspaceCodemapRootEpoch
    ) -> Bool {
        if lhs.rootID != rhs.rootID {
            return lhs.rootID.uuidString < rhs.rootID.uuidString
        }
        return lhs.rootLifetimeID.uuidString < rhs.rootLifetimeID.uuidString
    }
}

// swiftlint:enable cyclomatic_complexity function_body_length line_length identifier_name
