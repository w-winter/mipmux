// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: immutable headless data bindings and private phases; retained policy and output.
// Preserve source identifiers, DTO nesting and copied algorithm layout.
// swiftlint:disable cyclomatic_complexity function_body_length large_tuple line_length type_body_length for_where
import Foundation

struct RPCEGraphTraversal {
    let rootEpoch: WorkspaceCodemapRootEpoch
    let graphPolicy = WorkspaceCodemapGraphPolicy.initial

    func traverse(
        _ query: WorkspaceCodemapGraphStructureQuery,
        pinned: WorkspaceCodemapGraphPinnedSnapshot
    ) throws -> WorkspaceCodemapGraphStructureRootResult {
        let snapshot = pinned.snapshot
        let orderedSeedIDs = Set(query.seedFileIDs).sorted {
            Self.fileIDPrecedes($0, $1, snapshot: snapshot)
        }
        var issues: [WorkspaceCodemapGraphStructureIssue] = []
        var seeds: [WorkspaceCodemapGraphStructureSeed] = []
        var usableSeedIDs: [UUID] = []
        func classifySeed(_ fileID: UUID) {
            let slot = snapshot.slotsByFileID[fileID]
            let path = snapshot.nodesByFileID[fileID]?.standardizedRelativePath
                ?? slot?.standardizedRelativePath
            let state: WorkspaceCodemapStructureSeedState
            if pinned.isFenced(fileID) {
                state = .notIndexed
                issues.append(.seedFenced(fileID))
            } else if snapshot.nodesByFileID[fileID] != nil {
                state = .covered
                usableSeedIDs.append(fileID)
            } else if let slot {
                switch slot.state {
                case .pending:
                    state = .pending
                    issues.append(.seedPending(fileID))
                case .terminalExcluded:
                    state = .excluded
                    issues.append(.seedExcluded(fileID))
                case .terminalArtifact:
                    state = .notIndexed
                    issues.append(.seedNotIndexed(fileID))
                case .contributed, .empty:
                    state = .notIndexed
                    issues.append(.seedNotIndexed(fileID))
                }
            } else {
                state = .notIndexed
                issues.append(.seedNotIndexed(fileID))
            }
            seeds.append(WorkspaceCodemapGraphStructureSeed(
                fileID: fileID,
                standardizedRelativePath: path,
                state: state
            ))
        }
        for fileID in orderedSeedIDs {
            classifySeed(fileID)
        }

        if case .updatesPending = pinned.freshness { issues.append(.updatesPending) }
        if pinned.reconciling { issues.append(.watcherGapReconciling) }
        if !snapshot.coverage.isComplete { issues.append(.indexing) }

        guard !usableSeedIDs.isEmpty else {
            let hasPending = seeds.contains { $0.state == .pending } || !snapshot.coverage.isComplete
            return WorkspaceCodemapGraphStructureRootResult(
                rootEpoch: rootEpoch,
                status: hasPending ? .pending : .unavailable,
                coverage: snapshot.coverage,
                updatesPending: pinned.freshness != .current,
                reconciling: pinned.reconciling,
                receipt: pinned.receipt,
                seeds: seeds,
                nodes: [],
                edges: [],
                unresolved: [],
                truncation: nil,
                issues: issues
            )
        }

        let (deadlineDelta, deadlineOverflow) = graphPolicy.requestDeadlineMilliseconds
            .multipliedReportingOverflow(by: 1_000_000)
        let now = DispatchTime.now().uptimeNanoseconds
        let (candidateDeadline, deadlineAdditionOverflow) = now.addingReportingOverflow(deadlineDelta)
        let deadline = deadlineOverflow || deadlineAdditionOverflow ? UInt64.max : candidateDeadline
        let maximumDepth = query.direction == nil ? 0 : query.maximumDepth
        var nodesByFileID: [UUID: WorkspaceCodemapGraphStructureNode] = [:]
        var queue: [UUID] = []
        var queueIndex = 0
        var graphBytes: UInt64 = 0
        var droppedNodeCount = 0
        var truncated = false
        var deadlineReached = false

        func nodeByteCount(_ node: WorkspaceCodemapGraphSnapshotNode) -> UInt64? {
            guard let pathBytes = UInt64(exactly: node.standardizedRelativePath.utf8.count) else { return nil }
            let (value, overflow) = pathBytes.addingReportingOverflow(96)
            return overflow ? nil : value
        }

        for fileID in usableSeedIDs {
            guard let snapshotNode = snapshot.nodesByFileID[fileID],
                  !pinned.isFenced(fileID)
            else { continue }
            guard nodesByFileID.count < query.budget.maximumNodeCount,
                  let nodeBytes = nodeByteCount(snapshotNode),
                  graphBytes <= query.budget.maximumGraphByteCount,
                  nodeBytes <= query.budget.maximumGraphByteCount - graphBytes
            else {
                droppedNodeCount += 1
                truncated = true
                continue
            }
            graphBytes += nodeBytes
            nodesByFileID[fileID] = WorkspaceCodemapGraphStructureNode(
                fileID: fileID,
                standardizedRelativePath: snapshotNode.standardizedRelativePath,
                depth: 0,
                isSeed: true,
                reachedBy: []
            )
            queue.append(fileID)
        }

        var emittedEdges = Set<WorkspaceCodemapGraphStructureEdge>()
        func neighborsFor(_ currentID: UUID) -> [(evidence: WorkspaceCodemapGraphEdgeEvidence, fileID: UUID, reachedBy: WorkspaceCodemapStructureTraversalReachDirection)] {
            var neighbors: [(evidence: WorkspaceCodemapGraphEdgeEvidence, fileID: UUID, reachedBy: WorkspaceCodemapStructureTraversalReachDirection)] = []
            switch query.direction {
            case .none:
                break
            case .referencedDefinitions:
                neighbors = (snapshot.outgoingEdgesBySource[currentID] ?? []).map {
                    ($0, $0.targetFileID, .referencedDefinitions)
                }
            case .referrers:
                neighbors = snapshot.reverseEdges(target: currentID).map {
                    ($0, $0.sourceFileID, .referrers)
                }
            case .both:
                neighbors = (snapshot.outgoingEdgesBySource[currentID] ?? []).map {
                    ($0, $0.targetFileID, .referencedDefinitions)
                } + snapshot.reverseEdges(target: currentID).map {
                    ($0, $0.sourceFileID, .referrers)
                }
            }
            neighbors.sort { lhs, rhs in
                if lhs.fileID != rhs.fileID {
                    return Self.fileIDPrecedes(lhs.fileID, rhs.fileID, snapshot: snapshot)
                }
                if lhs.reachedBy != rhs.reachedBy {
                    return lhs.reachedBy.rawValue < rhs.reachedBy.rawValue
                }
                return Self.edgePrecedes(lhs.evidence, rhs.evidence, nodes: snapshot.nodesByFileID)
            }
            return neighbors
        }

        func visitNeighbor(_ neighbor: (evidence: WorkspaceCodemapGraphEdgeEvidence, fileID: UUID, reachedBy: WorkspaceCodemapStructureTraversalReachDirection), currentNode: WorkspaceCodemapGraphStructureNode) throws -> Bool {
            try Task.checkCancellation()
            guard !pinned.isFenced(neighbor.fileID),
                  !pinned.isFenced(neighbor.evidence.sourceFileID),
                  !pinned.isFenced(neighbor.evidence.targetFileID),
                  let snapshotNode = snapshot.nodesByFileID[neighbor.fileID]
            else { return true }

            let nextDepth = currentNode.depth + 1
            if let existing = nodesByFileID[neighbor.fileID] {
                if existing.depth == nextDepth, !existing.reachedBy.contains(neighbor.reachedBy) {
                    var reachedBy = existing.reachedBy
                    reachedBy.insert(neighbor.reachedBy)
                    nodesByFileID[neighbor.fileID] = WorkspaceCodemapGraphStructureNode(
                        fileID: existing.fileID,
                        standardizedRelativePath: existing.standardizedRelativePath,
                        depth: existing.depth,
                        isSeed: existing.isSeed,
                        reachedBy: reachedBy
                    )
                }
            } else {
                guard nodesByFileID.count < query.budget.maximumNodeCount,
                      let nodeBytes = nodeByteCount(snapshotNode),
                      graphBytes <= query.budget.maximumGraphByteCount,
                      nodeBytes <= query.budget.maximumGraphByteCount - graphBytes
                else {
                    droppedNodeCount += 1
                    truncated = true
                    return false
                }
                graphBytes += nodeBytes
                nodesByFileID[neighbor.fileID] = WorkspaceCodemapGraphStructureNode(
                    fileID: neighbor.fileID,
                    standardizedRelativePath: snapshotNode.standardizedRelativePath,
                    depth: nextDepth,
                    isSeed: false,
                    reachedBy: [neighbor.reachedBy]
                )
                queue.append(neighbor.fileID)
            }

            let edge = WorkspaceCodemapGraphStructureEdge(
                sourceFileID: neighbor.evidence.sourceFileID,
                targetFileID: neighbor.evidence.targetFileID,
                symbols: neighbor.evidence.matchedNames,
                ambiguous: neighbor.evidence.ambiguous
            )
            if !emittedEdges.contains(edge) {
                let symbolBytes = edge.symbols.reduce(0) { $0 + $1.utf8.count }
                guard emittedEdges.count < query.budget.maximumEdgeCount,
                      let payloadBytes = UInt64(exactly: 128 + symbolBytes),
                      graphBytes <= query.budget.maximumGraphByteCount,
                      payloadBytes <= query.budget.maximumGraphByteCount - graphBytes
                else {
                    truncated = true
                    return false
                }
                graphBytes += payloadBytes
                emittedEdges.insert(edge)
            }
            return true
        }

        func walkGraph() throws {
            traversal: while queueIndex < queue.count {
                try Task.checkCancellation()
                if DispatchTime.now().uptimeNanoseconds >= deadline {
                    deadlineReached = true
                    break
                }
                let currentID = queue[queueIndex]
                queueIndex += 1
                guard let currentNode = nodesByFileID[currentID], currentNode.depth < maximumDepth else { continue }

                let neighbors = neighborsFor(currentID)

                for neighbor in neighbors {
                    if try !visitNeighbor(neighbor, currentNode: currentNode) { break traversal }
                }
            }
        }
        try walkGraph()

        let orderedNodes = nodesByFileID.values.sorted {
            if $0.depth != $1.depth { return $0.depth < $1.depth }
            if $0.standardizedRelativePath != $1.standardizedRelativePath {
                return Self.utf8Precedes($0.standardizedRelativePath, $1.standardizedRelativePath)
            }
            return $0.fileID.uuidString < $1.fileID.uuidString
        }
        let orderedEdges = emittedEdges.sorted {
            let leftSource = snapshot.nodesByFileID[$0.sourceFileID]?.standardizedRelativePath ?? ""
            let rightSource = snapshot.nodesByFileID[$1.sourceFileID]?.standardizedRelativePath ?? ""
            if leftSource != rightSource { return Self.utf8Precedes(leftSource, rightSource) }
            let leftTarget = snapshot.nodesByFileID[$0.targetFileID]?.standardizedRelativePath ?? ""
            let rightTarget = snapshot.nodesByFileID[$1.targetFileID]?.standardizedRelativePath ?? ""
            if leftTarget != rightTarget { return Self.utf8Precedes(leftTarget, rightTarget) }
            return $0.symbols.lexicographicallyPrecedes($1.symbols, by: Self.utf8Precedes)
        }
        func unresolvedRecords() -> [WorkspaceCodemapGraphStructureUnresolved] {
            let visitedIDs = Set(nodesByFileID.keys)
            var unresolved: [WorkspaceCodemapGraphStructureUnresolved] = []
            for sourceID in visitedIDs.sorted(by: { Self.fileIDPrecedes($0, $1, snapshot: snapshot) }) {
                for record in snapshot.unresolvedBySource[sourceID] ?? [] {
                    unresolved.append(WorkspaceCodemapGraphStructureUnresolved(
                        sourceFileID: sourceID,
                        referencedName: record.referencedName,
                        reason: record.reason
                    ))
                }
            }
            unresolved.sort { lhs, rhs in
                if lhs.sourceFileID != rhs.sourceFileID {
                    return Self.fileIDPrecedes(lhs.sourceFileID, rhs.sourceFileID, snapshot: snapshot)
                }
                if lhs.referencedName != rhs.referencedName {
                    return Self.utf8Precedes(lhs.referencedName, rhs.referencedName)
                }
                return String(describing: lhs.reason) < String(describing: rhs.reason)
            }
            return unresolved
        }
        let unresolved = unresolvedRecords()

        if truncated { issues.append(.sizeLimit) }
        if deadlineReached { issues.append(.deadline) }
        let hasPartialIssue = !issues.isEmpty || unresolved.contains { $0.reason == .notIndexedYet }
        return WorkspaceCodemapGraphStructureRootResult(
            rootEpoch: rootEpoch,
            status: hasPartialIssue ? .partial : .ok,
            coverage: snapshot.coverage,
            updatesPending: pinned.freshness != .current,
            reconciling: pinned.reconciling,
            receipt: pinned.receipt,
            seeds: seeds,
            nodes: orderedNodes,
            edges: orderedEdges,
            unresolved: unresolved,
            truncation: truncated ? WorkspaceCodemapGraphStructureTruncation(
                droppedNodeCount: droppedNodeCount
            ) : nil,
            issues: issues
        )
    }

    private static func fileIDPrecedes(
        _ lhs: UUID,
        _ rhs: UUID,
        snapshot: WorkspaceCodemapGraphCommittedSnapshot
    ) -> Bool {
        fileIDPrecedes(lhs, rhs, nodes: snapshot.nodesByFileID)
    }

    private static func fileIDPrecedes(
        _ lhs: UUID,
        _ rhs: UUID,
        nodes: [UUID: WorkspaceCodemapGraphSnapshotNode]
    ) -> Bool {
        let left = nodes[lhs]?.standardizedRelativePath ?? ""
        let right = nodes[rhs]?.standardizedRelativePath ?? ""
        if left != right { return utf8Precedes(left, right) }
        return WorkspaceCodemapGraphOrdering.uuidPrecedes(lhs, rhs)
    }

    private static func edgePrecedes(
        _ lhs: WorkspaceCodemapGraphEdgeEvidence,
        _ rhs: WorkspaceCodemapGraphEdgeEvidence,
        nodes: [UUID: WorkspaceCodemapGraphSnapshotNode]
    ) -> Bool {
        if lhs.sourceFileID != rhs.sourceFileID { return fileIDPrecedes(lhs.sourceFileID, rhs.sourceFileID, nodes: nodes) }
        if lhs.targetFileID != rhs.targetFileID { return fileIDPrecedes(lhs.targetFileID, rhs.targetFileID, nodes: nodes) }
        return lhs.matchedNames.lexicographicallyPrecedes(rhs.matchedNames, by: utf8Precedes)
    }

    private static func utf8Precedes(_ lhs: String, _ rhs: String) -> Bool {
        WorkspaceCodemapGraphOrdering.utf8Precedes(lhs, rhs)
    }
}

// swiftlint:enable cyclomatic_complexity function_body_length large_tuple line_length type_body_length for_where
