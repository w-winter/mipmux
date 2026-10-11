// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: immutable headless data bindings and private phases; retained policy and output.
// Preserve source identifiers, DTO nesting and copied algorithm layout.
// swiftlint:disable function_body_length
import Foundation

enum StructureRootQueries {
    static func query(
        roots inputs: [RPCEStructureSeedResolver.RootSeeds],
        inventoryDigest: String,
        direction: WorkspaceCodemapStructureTraversalDirection?,
        maximumDepth: Int,
        budget: WorkspaceCodemapGraphQueryBudget
    ) throws -> WorkspaceCodemapStructureAggregateResult {
        let mapping = RPCEGraphMapping()
        var remainingNodes = budget.maximumNodeCount
        var remainingEdges = budget.maximumEdgeCount
        var remainingBytes = budget.maximumGraphByteCount
        var roots: [WorkspaceCodemapStructureRootResult] = []
        for input in inputs.filter({ !$0.seeds.isEmpty }).sorted(by: { mapping.codemapRootEpochPrecedes(
            $0.root.epoch,
            $1.root.epoch
        ) }) {
            try Task.checkCancellation()
            let files = Dictionary(uniqueKeysWithValues: input.root.files.map { ($0.id, $0) })
            let rootSeedIDs = Set(input.seeds).sorted { lhs, rhs in
                let left = files[lhs]!.path, right = files[rhs]!.path
                if left != right { return WorkspaceCodemapGraphOrdering.utf8Precedes(left, right) }
                return WorkspaceCodemapGraphOrdering.uuidPrecedes(lhs, rhs)
            }
            let raw: WorkspaceCodemapGraphStructureRootResult
            if remainingNodes <= 0 || remainingBytes == 0 {
                raw = WorkspaceCodemapGraphStructureRootResult(
                    rootEpoch: input.root.epoch, status: .partial, coverage: nil, updatesPending: false,
                    reconciling: false, receipt: nil,
                    seeds: rootSeedIDs.map { WorkspaceCodemapGraphStructureSeed(
                        fileID: $0,
                        standardizedRelativePath: files[$0]!.path,
                        state: .notIndexed
                    ) },
                    nodes: [], edges: [], unresolved: [],
                    truncation: WorkspaceCodemapGraphStructureTruncation(droppedNodeCount: rootSeedIDs.count),
                    issues: [.sizeLimit]
                )
            } else {
                let pinned = try pinnedSnapshot(input.root, inventoryDigest: inventoryDigest)
                raw = try RPCEGraphTraversal(rootEpoch: input.root.epoch).traverse(WorkspaceCodemapGraphStructureQuery(
                    seedFileIDs: rootSeedIDs, direction: direction, maximumDepth: maximumDepth,
                    budget: WorkspaceCodemapGraphQueryBudget(
                        maximumTokenCount: budget.maximumTokenCount,
                        maximumNodeCount: remainingNodes,
                        maximumEdgeCount: remainingEdges,
                        maximumGraphByteCount: remainingBytes,
                        graphEvidenceTokenCount: budget.graphEvidenceTokenCount,
                        renderTokenCount: budget.renderTokenCount
                    )
                ), pinned: pinned)
            }
            let seedPaths = Dictionary(uniqueKeysWithValues: rootSeedIDs
                .map { ($0, input.root.name + "/" + files[$0]!.path) })
            let mapped = mapping.mapCodemapStructureRoot(raw, rootName: input.root.name, seedPathsByFileID: seedPaths)
            roots.append(mapped)
            remainingNodes = max(0, remainingNodes - mapped.nodes.count)
            remainingEdges = max(0, remainingEdges - mapped.edges.count)
            let usedBytes = graphBytes(mapped)
            remainingBytes = usedBytes >= remainingBytes ? 0 : remainingBytes - usedBytes
        }
        let hasUsefulData = roots.contains(where: \.hasUsefulData)
        let status: WorkspaceCodemapStructureStatus = if hasUsefulData {
            roots.allSatisfy { $0.status == .ok } ? .ok : .partial
        } else if roots.contains(where: { $0.status == .pending }) {
            .pending
        } else {
            .unavailable
        }
        return WorkspaceCodemapStructureAggregateResult(status: status, roots: roots, issues: [])
    }

    private static func pinnedSnapshot(
        _ input: StructureInput.Root,
        inventoryDigest: String
    ) throws -> WorkspaceCodemapGraphPinnedSnapshot {
        let coverage = WorkspaceCodemapGraphCatalogCoverage(
            supportedCount: UInt64(input.files.count(where: { $0.state != nil })),
            classifiedCount: UInt64(input.files
                .count(where: { $0.state != nil && $0.state != .pending })),
            isComplete: input.complete && !input.files.contains(where: { $0.state == .pending })
        )
        let slots = Dictionary(uniqueKeysWithValues: input.files.compactMap { file in
            file.state.map { (file.id, WorkspaceCodemapGraphSlot(standardizedRelativePath: file.path, state: $0)) }
        })
        let nodes = Dictionary(uniqueKeysWithValues: input.files
            .filter { $0.state == .contributed || $0.state == .empty }.map {
                (
                    $0.id,
                    WorkspaceCodemapGraphSnapshotNode(
                        fileID: $0.id,
                        standardizedRelativePath: $0.path,
                        contribution: $0.contribution
                    )
                )
            })
        let snapshot = try StructureAdjacency.snapshot(slots: slots, nodes: nodes, coverage: coverage)
        return WorkspaceCodemapGraphPinnedSnapshot(
            snapshot: snapshot,
            receipt: WorkspaceCodemapGraphSnapshotReceipt(inventoryDigest: inventoryDigest),
            freshness: .current,
            reconciling: false,
            fencedFileIDs: []
        )
    }

    private static func graphBytes(_ mapped: WorkspaceCodemapStructureRootResult) -> UInt64 {
        var usedBytes = UInt64(0)
        for node in mapped.nodes {
            let nodeBytes = UInt64(node.path.utf8.count) + 96
            usedBytes = usedBytes.addingReportingOverflow(nodeBytes).overflow ? .max : usedBytes + nodeBytes
        }
        for edge in mapped.edges {
            var edgeBytes = UInt64(edge.fromPath.utf8.count + edge.toPath.utf8.count) + 128
            for symbol in edge.symbols {
                edgeBytes = edgeBytes.addingReportingOverflow(UInt64(symbol.utf8.count))
                    .overflow ? .max : edgeBytes + UInt64(symbol.utf8.count)
            }
            usedBytes = usedBytes.addingReportingOverflow(edgeBytes).overflow ? .max : usedBytes + edgeBytes
        }
        return usedBytes
    }
}

// swiftlint:enable function_body_length
