// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: immutable collection bindings and local collection-accounting phases.
import Foundation

struct WorkspaceCodemapGraphSizeAccounting: Hashable {
    static let zero = Self(nodes: 0, postings: 0, edges: 0, bytes: 0)

    let nodes: UInt64
    let postings: UInt64
    let edges: UInt64
    let bytes: UInt64
}

enum RPCEGraphSizeAccounting {
    enum CandidateSizeOutcome {
        case size(WorkspaceCodemapGraphSizeAccounting)
        case overflow
        case cancelled
    }

    // Both slot/node contributions and both adjacency directions are charged by the source model.
    // swiftlint:disable:next function_body_length function_parameter_count
    static func fullSize(
        slots: [UUID: WorkspaceCodemapGraphSlot],
        nodes: [UUID: WorkspaceCodemapGraphSnapshotNode],
        definitions: [String: Set<UUID>],
        references: [String: Set<UUID>],
        outgoing: [UUID: [WorkspaceCodemapGraphEdgeEvidence]],
        reverse: [UUID: [UUID: WorkspaceCodemapGraphEdgeEvidence]],
        unresolved: [UUID: [WorkspaceCodemapGraphUnresolvedRecord]]
    ) -> CandidateSizeOutcome {
        var postingCount: UInt64 = 0
        var edgeCount: UInt64 = 0
        var byteCount: UInt64 = 0
        func charge(_ bytes: UInt64?) -> Bool {
            guard let next = checkedAdd(byteCount, bytes) else { return false }
            byteCount = next
            return true
        }
        func count(_ value: Int, into total: inout UInt64) -> Bool {
            guard let next = checkedAdd(total, UInt64(exactly: value)) else { return false }
            total = next
            return true
        }
        func contributionFailure() -> CandidateSizeOutcome? {
            for node in nodes.values {
                guard !Task.isCancelled else { return .cancelled }
                guard charge(nodeBytes(node)) else { return .overflow }
            }
            for slot in slots.values {
                guard !Task.isCancelled else { return .cancelled }
                guard charge(slotBytes(slot)) else { return .overflow }
            }
            return nil
        }
        func postingFailure() -> CandidateSizeOutcome? {
            for (name, fileIDs) in definitions {
                guard !Task.isCancelled else { return .cancelled }
                let postingTotal = fileIDs.count + (references[name]?.count ?? 0)
                guard count(fileIDs.count, into: &postingCount),
                      charge(postingBytes(name: name, fileIDCount: postingTotal))
                else { return .overflow }
            }
            for (name, fileIDs) in references {
                guard !Task.isCancelled else { return .cancelled }
                guard count(fileIDs.count, into: &postingCount) else { return .overflow }
                guard definitions[name] == nil else { continue }
                guard charge(postingBytes(name: name, fileIDCount: fileIDs.count)) else { return .overflow }
            }
            return nil
        }
        func outgoingFailure() -> CandidateSizeOutcome? {
            for evidenceList in outgoing.values {
                guard !Task.isCancelled else { return .cancelled }
                guard count(evidenceList.count, into: &edgeCount) else { return .overflow }
                for evidence in evidenceList {
                    guard charge(evidenceBytes(evidence)) else { return .overflow }
                }
            }
            return nil
        }
        func reverseFailure() -> CandidateSizeOutcome? {
            for bySource in reverse.values {
                guard !Task.isCancelled else { return .cancelled }
                for evidence in bySource.values {
                    guard charge(evidenceBytes(evidence)) else { return .overflow }
                }
            }
            return nil
        }
        func unresolvedFailure() -> CandidateSizeOutcome? {
            for records in unresolved.values {
                guard !Task.isCancelled else { return .cancelled }
                for record in records {
                    guard charge(unresolvedBytes(record)) else { return .overflow }
                }
            }
            return nil
        }

        if let failure = contributionFailure() { return failure }
        if let failure = postingFailure() { return failure }
        if let failure = outgoingFailure() { return failure }
        if let failure = reverseFailure() { return failure }
        if let failure = unresolvedFailure() { return failure }
        guard charge(checkedMultiply(edgeCount, 96)),
              charge(checkedMultiply(postingCount, 24)),
              let nodeCount = UInt64(exactly: nodes.count)
        else { return .overflow }
        return .size(WorkspaceCodemapGraphSizeAccounting(
            nodes: nodeCount,
            postings: postingCount,
            edges: edgeCount,
            bytes: byteCount
        ))
    }

    private static func nodeBytes(_ node: WorkspaceCodemapGraphSnapshotNode) -> UInt64? {
        guard let pathBytes = UInt64(exactly: node.standardizedRelativePath.utf8.count),
              let definitionBytes = checkedStringBytes(node.contribution.sortedUniqueDefinitions),
              let referenceBytes = checkedStringBytes(node.contribution.sortedUniqueReferences)
        else { return nil }
        return checkedAdd(checkedAdd(checkedAdd(192, pathBytes), definitionBytes), referenceBytes)
    }

    private static func slotBytes(_ slot: WorkspaceCodemapGraphSlot) -> UInt64? {
        let contribution = slot.state.contribution
        guard let pathBytes = UInt64(exactly: slot.standardizedRelativePath.utf8.count),
              let definitionBytes = checkedStringBytes(contribution?.sortedUniqueDefinitions ?? []),
              let referenceBytes = checkedStringBytes(contribution?.sortedUniqueReferences ?? [])
        else { return nil }
        return checkedAdd(checkedAdd(checkedAdd(192, pathBytes), definitionBytes), referenceBytes)
    }

    private static func postingBytes(name: String, fileIDCount: Int) -> UInt64? {
        guard let nameBytes = UInt64(exactly: name.utf8.count),
              let count = UInt64(exactly: fileIDCount)
        else { return nil }
        return checkedAdd(checkedAdd(64, nameBytes), checkedMultiply(count, 16))
    }

    private static func evidenceBytes(_ evidence: WorkspaceCodemapGraphEdgeEvidence) -> UInt64? {
        checkedAdd(128, checkedStringBytes(evidence.matchedNames))
    }

    private static func unresolvedBytes(_ record: WorkspaceCodemapGraphUnresolvedRecord) -> UInt64? {
        checkedAdd(96, UInt64(exactly: record.referencedName.utf8.count))
    }

    private static func checkedAdd(_ lhs: UInt64?, _ rhs: UInt64?) -> UInt64? {
        guard let lhs, let rhs else { return nil }
        let (result, overflow) = lhs.addingReportingOverflow(rhs)
        return overflow ? nil : result
    }

    private static func checkedMultiply(_ lhs: UInt64, _ rhs: UInt64) -> UInt64? {
        let (result, overflow) = lhs.multipliedReportingOverflow(by: rhs)
        return overflow ? nil : result
    }

    private static func checkedStringBytes(_ strings: [String]) -> UInt64? {
        var result: UInt64 = 0
        for string in strings {
            guard let count = UInt64(exactly: string.utf8.count),
                  let withPayload = checkedAdd(result, count),
                  let withOverhead = checkedAdd(withPayload, 16)
            else { return nil }
            result = withOverhead
        }
        return result
    }
}
