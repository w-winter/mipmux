// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: immutable headless data bindings and private phases; retained policy and output.
// Preserve source identifiers, DTO nesting and copied algorithm layout.
// swiftlint:disable function_body_length
import Foundation

enum StructureAdjacency {
    // swiftlint:disable:next cyclomatic_complexity
    static func snapshot(
        slots: [UUID: WorkspaceCodemapGraphSlot],
        nodes: [UUID: WorkspaceCodemapGraphSnapshotNode],
        coverage: WorkspaceCodemapGraphCatalogCoverage
    ) throws -> WorkspaceCodemapGraphCommittedSnapshot? {
        let graphPolicy = WorkspaceCodemapGraphPolicy.initial
        var definitions: [String: Set<UUID>] = [:]
        var references: [String: Set<UUID>] = [:]
        for (fileID, node) in nodes {
            for name in node.contribution.sortedUniqueDefinitions {
                definitions[name, default: []].insert(fileID)
            }
            for name in node.contribution.sortedUniqueReferences {
                references[name, default: []].insert(fileID)
            }
        }
        var outgoing: [UUID: [WorkspaceCodemapGraphEdgeEvidence]] = [:]
        var reverse: [UUID: [UUID: WorkspaceCodemapGraphEdgeEvidence]] = [:]
        var unresolved: [UUID: [WorkspaceCodemapGraphUnresolvedRecord]] = [:]
        let utf8Precedes = WorkspaceCodemapGraphOrdering.utf8Precedes
        for (source, node) in nodes {
            try Task.checkCancellation()
            var namesByTarget: [UUID: Set<String>] = [:]
            var candidateCountByTarget: [UUID: UInt64] = [:]
            var sourceUnresolved: [WorkspaceCodemapGraphUnresolvedRecord] = []
            for name in node.contribution.sortedUniqueReferences {
                let candidates = definitions[name] ?? []
                guard !candidates.isEmpty else {
                    sourceUnresolved.append(.init(
                        sourceFileID: source,
                        referencedName: name,
                        reason: coverage.isComplete ? .missing : .notIndexedYet
                    ))
                    continue
                }
                guard candidates.count <= graphPolicy.candidateOverflowThreshold else {
                    sourceUnresolved.append(.init(
                        sourceFileID: source,
                        referencedName: name,
                        reason: .tooCommon
                    ))
                    continue
                }
                for target in candidates {
                    namesByTarget[target, default: []].insert(name)
                    candidateCountByTarget[target] = UInt64(candidates.count)
                }
            }
            var sourceEvidence: [WorkspaceCodemapGraphEdgeEvidence] = []
            sourceEvidence.reserveCapacity(namesByTarget.count)
            for (target, names) in namesByTarget {
                let count = candidateCountByTarget[target] ?? 0
                let evidence = WorkspaceCodemapGraphEdgeEvidence(
                    sourceFileID: source,
                    targetFileID: target,
                    matchedNames: names.sorted(by: utf8Precedes),
                    candidateCount: count,
                    ambiguous: count > 1
                )
                sourceEvidence.append(evidence)
                reverse[target, default: [:]][source] = evidence
            }
            outgoing[source] = sourceEvidence
            unresolved[source] = sourceUnresolved
        }
        let size: WorkspaceCodemapGraphSizeAccounting
        switch RPCEGraphSizeAccounting.fullSize(
            slots: slots, nodes: nodes, definitions: definitions, references: references,
            outgoing: outgoing, reverse: reverse, unresolved: unresolved
        ) {
        case let .size(value): size = value
        case .cancelled: throw CancellationError()
        case .overflow:
            FileHandle.standardError.write(Data(
                "{\"level\":\"warn\",\"event\":\"codemapGraphAccountingOverflow\"}\n".utf8
            ))
            return nil
        }
        let limits = graphPolicy.graphSizePolicy
        for (dimension, attempted, limit) in [
            ("nodes", size.nodes, limits.maxNodes),
            ("postings", size.postings, limits.maxPostings),
            ("edges", size.edges, limits.maxEdges),
            ("bytes", size.bytes, limits.maxBytes)
        ] where attempted > limit {
            let diagnostic = "{\"level\":\"warn\",\"event\":\"codemapGraphSizeRejected\","
                + "\"dimension\":\"\(dimension)\",\"attempted\":\(attempted),\"limit\":\(limit)}\n"
            FileHandle.standardError.write(Data(diagnostic.utf8))
            return nil
        }
        return WorkspaceCodemapGraphCommittedSnapshot(
            slotsByFileID: slots, nodesByFileID: nodes, outgoingEdgesBySource: outgoing,
            reverseEdgesByTarget: reverse, unresolvedBySource: unresolved, coverage: coverage
        )
    }
}

// swiftlint:enable function_body_length
