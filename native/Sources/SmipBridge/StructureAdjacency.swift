// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: immutable headless data bindings and private phases; retained policy and output.
// Preserve source identifiers, DTO nesting and copied algorithm layout.
// swiftlint:disable function_body_length
import Foundation

enum StructureAdjacency {
    static func snapshot(
        slots: [UUID: WorkspaceCodemapGraphSlot],
        nodes: [UUID: WorkspaceCodemapGraphSnapshotNode],
        coverage: WorkspaceCodemapGraphCatalogCoverage
    ) throws -> WorkspaceCodemapGraphCommittedSnapshot {
        let graphPolicy = WorkspaceCodemapGraphPolicy.initial
        var definitions: [String: [UUID]] = [:]
        for (fileID, node) in nodes {
            for name in node.contribution.sortedUniqueDefinitions {
                definitions[name, default: []].append(fileID)
            }
        }
        var outgoing: [UUID: [WorkspaceCodemapGraphEdgeEvidence]] = [:]
        var reverse: [UUID: [WorkspaceCodemapGraphEdgeEvidence]] = [:]
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
                reverse[target, default: []].append(evidence)
            }
            outgoing[source] = sourceEvidence
            unresolved[source] = sourceUnresolved
        }
        return WorkspaceCodemapGraphCommittedSnapshot(
            slotsByFileID: slots, nodesByFileID: nodes, outgoingEdgesBySource: outgoing,
            reverseEdgesByTarget: reverse, unresolvedBySource: unresolved, coverage: coverage
        )
    }
}

// swiftlint:enable function_body_length
