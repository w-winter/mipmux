import Foundation

struct WorkspaceCodemapRootEpoch: Hashable { let rootID: UUID; let rootLifetimeID: UUID }
struct WorkspaceCodemapGraphSnapshotReceipt: Hashable {}
struct WorkspaceCodemapGraphCatalogCoverage: Hashable {}
enum WorkspaceCodemapGraphSnapshotFreshness: Hashable { case current, updatesPending }
enum WorkspaceCodemapGraphRevocationReason: Hashable { case rootAuthorityChanged }
enum SlotState { case pending, contributed, empty, terminalArtifact, terminalExcluded }
struct Slot { let state: SlotState; var requestGeneration: UInt64 {
    0
}; var pathGeneration: UInt64 {
    0
} }
struct WorkspaceCodemapGraphSnapshotNode {
    let standardizedRelativePath: String
    var requestGeneration: UInt64 {
        0
    }; var pathGeneration: UInt64 {
        0
    }
}

struct Edge { let targetFileID: UUID }
struct WorkspaceCodemapGraphCommittedSnapshot {
    let coverage = WorkspaceCodemapGraphCatalogCoverage()
    let slotsByFileID: [UUID: Slot]
    let nodesByFileID: [UUID: WorkspaceCodemapGraphSnapshotNode]
    let outgoingEdgesBySource: [UUID: [Edge]]
    let unresolvedBySource: [UUID: [String]]
}

struct Pinned {
    let snapshot: WorkspaceCodemapGraphCommittedSnapshot
    let receipt = WorkspaceCodemapGraphSnapshotReceipt()
    let coverage = WorkspaceCodemapGraphCatalogCoverage()
    var freshness: WorkspaceCodemapGraphSnapshotFreshness {
        .current
    }

    var reconciling: Bool {
        false
    }

    func isFenced(_: UUID) -> Bool {
        false
    }
}

enum Latest { case pending, revoked(WorkspaceCodemapGraphRevocationReason), ready(Pinned) }
enum WorkspaceCodemapGraphOrdering {
    static func uuidPrecedes(_ lhs: UUID, _ rhs: UUID) -> Bool {
        lhs.uuidString < rhs.uuidString
    }

    static func utf8Precedes(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf8.lexicographicallyPrecedes(rhs.utf8)
    }
}

struct Case: Decodable {
    struct File: Decodable {
        let path: String; let count: Int; let selected: Bool; let definitions: [String]; let references: [String]
    }

    struct Budget: Decodable { let targets: Int; let resolutions: Int; let referenceFailures: Int; let bytes: Int }
    let name: String; let files: [File]; let budget: Budget

    func run() -> [String: Any] {
        var paths: [UUID: String] = [:], definitions: [String: Set<UUID>] = [:], references: [UUID: Set<String>] = [:]
        var seeds: [WorkspaceCodemapAutomaticSelectionGraphSeed] = []
        for group in files {
            for index in 0 ..< group.count {
                let id = UUID(uuidString: String(format: "00000000-0000-0000-0000-%012llx", UInt64(paths.count + 1)))!
                paths[id] = group.path.replacingOccurrences(of: "{i}", with: String(index))
                for name in group.definitions {
                    definitions[name, default: []].insert(id)
                }
                references[id] = Set(group.references)
                if group.selected { seeds.append(.init(fileID: id, requestGeneration: 0)) }
            }
        }
        let snapshot = Self.snapshot(paths: paths, definitions: definitions, references: references)
        let graph = OriginalGraph(pinned: Pinned(snapshot: snapshot))
        let result = graph.automaticSelectionLatest(.init(rootEpoch: graph.rootEpoch, sources: seeds,
                                                          maximumTargetCount: budget.targets,
                                                          maximumResolutionCount: budget.resolutions,
                                                          maximumReferenceFailureCount: budget.referenceFailures,
                                                          maximumByteCount: budget.bytes))
        let output: [String: Any]
        switch result {
        case let .ready(value):
            output = ["kind": "ready", "targets": value.targets.map(\.standardizedRelativePath), "counts": [
                "targets": value.targets.count, "resolutions": value.resolutionCount,
                "referenceFailures": value.referenceFailureCount, "bytes": value.materializedByteCount
            ]]
        case let .budget(reason): output = ["kind": "budget", "reason": Self.reason(reason)]
        case .pending, .revoked, .cancelled: fatalError("Unexpected disposition for a captured settled graph")
        }
        return ["name": name, "expected": output]
    }

    private static func snapshot(paths: [UUID: String], definitions: [String: Set<UUID>],
                                 references: [UUID: Set<String>]) -> WorkspaceCodemapGraphCommittedSnapshot {
        var outgoing: [UUID: [Edge]] = [:], unresolved: [UUID: [String]] = [:]
        for (id, names) in references {
            var targets = Set<UUID>()
            for name in names {
                let matches = definitions[name] ?? []
                if matches.isEmpty || matches.count > 4096 {
                    unresolved[id, default: []].append(name)
                } else {
                    targets.formUnion(matches)
                }
            }
            outgoing[id] = targets.map { Edge(targetFileID: $0) }
        }
        return WorkspaceCodemapGraphCommittedSnapshot(
            slotsByFileID: paths.mapValues { _ in Slot(state: .contributed) },
            nodesByFileID: paths.mapValues { WorkspaceCodemapGraphSnapshotNode(standardizedRelativePath: $0) },
            outgoingEdgesBySource: outgoing, unresolvedBySource: unresolved
        )
    }

    private static func reason(_ reason: WorkspaceCodemapAutomaticSelectionBudgetReason) -> [String: Any] {
        switch reason {
        case let .resolutionLimit(attempted, limit): return [
                "kind": "resolutionLimit",
                "attempted": attempted,
                "limit": limit
            ]
        case let .referenceFailureLimit(attempted, limit): return [
                "kind": "referenceFailureLimit",
                "attempted": attempted,
                "limit": limit
            ]
        case let .targetLimit(attempted, limit): return ["kind": "targetLimit", "attempted": attempted, "limit": limit]
        case let .byteLimit(attempted, limit): return ["kind": "byteLimit", "attempted": attempted, "limit": limit]
        default: fatalError("Unexpected root-query budget reason")
        }
    }
}
