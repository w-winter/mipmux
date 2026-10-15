import Foundation

struct SizeCase: Decodable {
    struct File: Decodable {
        let path: String
        let state: String?
        let definitions: [String]
        let references: [String]

        func slot() -> WorkspaceCodemapGraphSlot? {
            guard let state else { return nil }
            func names(_ input: [String]) -> [String] {
                Set(input.map(\.precomposedStringWithCanonicalMapping)).sorted()
            }
            let contribution = StructureContribution(
                sortedUniqueDefinitions: names(definitions),
                sortedUniqueReferences: names(references)
            )
            let value: WorkspaceCodemapGraphSlotState
            switch state {
            case "contributed": value = .contributed(contribution)
            case "empty": value = .empty(contribution)
            case "pending": value = .pending
            case "terminalArtifact": value = .terminalArtifact
            case "terminalExcluded": value = .terminalExcluded
            default: fatalError("Unknown captured slot state")
            }
            return WorkspaceCodemapGraphSlot(standardizedRelativePath: path, state: value)
        }
    }

    let name: String
    let files: [File]

    func run() throws -> [String: Any] {
        let slots = Dictionary(uniqueKeysWithValues: files.enumerated().compactMap { index, file in
            file.slot().map { (
                UUID(uuidString: String(format: "00000000-0000-0000-0000-%012llx", UInt64(index + 1)))!,
                $0
            ) }
        })
        let nodes = Dictionary(uniqueKeysWithValues: slots.compactMap { id, slot in
            slot.state.contribution.map { (
                id,
                WorkspaceCodemapGraphSnapshotNode(fileID: id,
                                                  standardizedRelativePath: slot
                                                      .standardizedRelativePath,
                                                  contribution: $0)
            ) }
        })
        let definitions = Self.postings(nodes, names: \.sortedUniqueDefinitions)
        let references = Self.postings(nodes, names: \.sortedUniqueReferences)
        let coverage = WorkspaceCodemapGraphCatalogCoverage(
            supportedCount: UInt64(slots.count),
            classifiedCount: UInt64(slots.count),
            isComplete: true
        )
        guard let graph = try StructureAdjacency.snapshot(slots: slots, nodes: nodes, coverage: coverage) else {
            fatalError("Small source fixture unexpectedly exceeds resident policy")
        }
        switch RPCEGraphSizeAccounting.fullSize(
            slots: slots,
            nodes: nodes,
            definitions: definitions,
            references: references,
            outgoing: graph.outgoingEdgesBySource,
            reverse: graph.reverseEdgesByTarget,
            unresolved: graph.unresolvedBySource
        ) {
        case let .size(size): return ["name": name, "expected": [
                "nodes": String(size.nodes), "postings": String(size.postings), "edges": String(size.edges),
                "bytes": String(size.bytes)
            ]]
        case .overflow, .cancelled: fatalError("Unexpected accounting failure for a small source fixture")
        }
    }

    private static func postings(_ nodes: [UUID: WorkspaceCodemapGraphSnapshotNode],
                                 names: KeyPath<StructureContribution, [String]>) -> [String: Set<UUID>] {
        var result: [String: Set<UUID>] = [:]
        for (id, node) in nodes {
            for name in node.contribution[keyPath: names] {
                result[name, default: []].insert(id)
            }
        }
        return result
    }
}

let cases = try JSONDecoder().decode([SizeCase].self, from: FileHandle.standardInput.readDataToEndOfFile())
try FileHandle.standardOutput.write(JSONSerialization.data(
    withJSONObject: cases.map { try $0.run() },
    options: [.sortedKeys]
))
