import Foundation

// Type names match the extracted RPCE declarations.
// swiftlint:disable type_name

struct WorkspaceCodemapRootEpoch: Hashable {
    let rootID: UUID
    let rootLifetimeID: UUID
}

struct WorkspaceCodemapLogicalPresentationPath: Hashable {
    let displayPath: String
}

struct WorkspaceCodemapGraphCatalogCoverage: Equatable {}
struct WorkspaceCodemapAutomaticSelectionRootReceipt: Equatable {}
struct WorkspaceCodemapAutomaticSelectionReceipt: Equatable {}
struct WorkspaceCodemapGraphRevocationReason: Equatable {}
struct WorkspaceCodemapArtifactDemandUnavailableReason: Equatable {}
struct WorkspaceCodemapGraphReceiptInvalidReason: Equatable {}

typealias PersistentHashMap<Key: Hashable, Value> = [Key: Value]

enum FixtureSlotState: String, Decodable {
    case contributed, empty, pending, terminalArtifact, terminalExcluded
}

struct Slot {
    let state: FixtureSlotState
    let requestGeneration: UInt64 = 0
    let pathGeneration: UInt64 = 0
}

struct WorkspaceCodemapGraphSnapshotNode {
    let standardizedRelativePath: String
}

struct WorkspaceCodemapGraphCommittedSnapshot {
    let slotsByFileID: [UUID: Slot]
    let nodesByFileID: PersistentHashMap<UUID, WorkspaceCodemapGraphSnapshotNode>
}

struct Pinned {
    let snapshot: WorkspaceCodemapGraphCommittedSnapshot
    func isFenced(_: UUID) -> Bool {
        false
    }
}

struct WorkspaceCodemapAutomaticSelectionGraphQuery {
    let sources: [WorkspaceCodemapAutomaticSelectionGraphSeed]
}

struct ReadyGraphResult {
    let sources: [WorkspaceCodemapAutomaticSelectionGraphSource]
    let reconciling = false
}

// swiftlint:enable type_name
// swiftlint:disable:next function_parameter_count
func makeRootResult(
    rootEpoch: WorkspaceCodemapRootEpoch,
    status: WorkspaceCodemapAutomaticSelectionStatus,
    targets: [WorkspaceCodemapAutomaticSelectionTarget],
    sources: [WorkspaceCodemapAutomaticSelectionGraphSource],
    issues: [WorkspaceCodemapAutomaticSelectionIssue],
    receipt: WorkspaceCodemapAutomaticSelectionRootReceipt?
) -> WorkspaceCodemapAutomaticSelectionRootResult {
    WorkspaceCodemapAutomaticSelectionRootResult(
        rootEpoch: rootEpoch, status: status,
        targets: targets.sorted(by: automaticSelectionTargetPrecedes), sources: sources,
        issues: issues.sorted(by: automaticSelectionIssuePrecedes), coverage: nil,
        graphTargetCount: targets.count, graphResolutionCount: 0,
        graphReferenceFailureCount: 0, graphByteCount: 0, receipt: receipt
    )
}

struct FixtureDocument: Decodable {
    let rootLabels: [String]
    let cases: [FixtureCase]
}

struct FixtureCase: Decodable {
    let name: String
    let roots: [FixtureRoot]
}

struct FixtureRoot: Decodable {
    enum Kind: String, Decodable { case ready, pendingAggregateInput, unavailableAggregateInput }
    struct Source: Decodable {
        let path: String
        let slot: FixtureSlotState?
    }

    let root: String
    let kind: Kind
    let sources: [Source]
    let targets: [String]
}

struct FileLabel: Hashable {
    let rootEpoch: WorkspaceCodemapRootEpoch
    let fileID: UUID
}

struct FixtureRun {
    let rootLabels: [String]
    var rootsByEpoch: [WorkspaceCodemapRootEpoch: String] = [:]
    var pathsByFile: [FileLabel: String] = [:]

    private func fixtureID(_ ordinal: Int, prefix: String) -> UUID {
        UUID(uuidString: prefix + String(format: "%012llx", UInt64(ordinal)))!
    }

    mutating func resolve(_ root: FixtureRoot) -> WorkspaceCodemapAutomaticSelectionRootResult {
        let ordinal = rootLabels.firstIndex(of: root.root)! + 1
        let epoch = WorkspaceCodemapRootEpoch(
            rootID: fixtureID(ordinal, prefix: "00000000-0000-0000-0000-"),
            rootLifetimeID: fixtureID(ordinal, prefix: "10000000-0000-0000-0000-")
        )
        rootsByEpoch[epoch] = root.root
        switch root.kind {
        case .pendingAggregateInput, .unavailableAggregateInput:
            precondition(root.sources.isEmpty && root.targets.isEmpty)
            let pending = root.kind == .pendingAggregateInput
            return makeRootResult(
                rootEpoch: epoch, status: pending ? .pending : .unavailable, targets: [], sources: [],
                issues: pending ? [.graphNotInitialized(epoch)] : [.graphUnavailable(epoch)], receipt: nil
            )
        case .ready:
            break
        }

        var slots: [UUID: Slot] = [:]
        var nodes: [UUID: WorkspaceCodemapGraphSnapshotNode] = [:]
        var validSources: [WorkspaceCodemapAutomaticSelectionSourceIdentity] = []
        for (index, source) in root.sources.enumerated() {
            let id = fixtureID(index + 1, prefix: "20000000-0000-0000-0000-")
            pathsByFile[FileLabel(rootEpoch: epoch, fileID: id)] = source.path
            if let state = source.slot { slots[id] = Slot(state: state) }
            if source.slot == .contributed || source.slot == .empty {
                nodes[id] = WorkspaceCodemapGraphSnapshotNode(standardizedRelativePath: source.path)
            }
            validSources.append(.init(rootEpoch: epoch, fileID: id, catalogGeneration: 0, requestGeneration: 0))
        }
        let targets = root.targets.enumerated().map { index, path in
            let id = fixtureID(root.sources.count + index + 1, prefix: "20000000-0000-0000-0000-")
            pathsByFile[FileLabel(rootEpoch: epoch, fileID: id)] = path
            return WorkspaceCodemapAutomaticSelectionTarget(
                rootEpoch: epoch, fileID: id, catalogGeneration: 0, requestGeneration: 0,
                logicalPath: WorkspaceCodemapLogicalPresentationPath(displayPath: root.root + "/" + path)
            )
        }
        let query = WorkspaceCodemapAutomaticSelectionGraphQuery(sources: validSources.map {
            WorkspaceCodemapAutomaticSelectionGraphSeed(fileID: $0.fileID, requestGeneration: $0.requestGeneration)
        })
        let sources = OriginalSourceClassification.classify(
            query: query, pinned: Pinned(snapshot: WorkspaceCodemapGraphCommittedSnapshot(
                slotsByFileID: slots, nodesByFileID: nodes
            ))
        )
        return resolveReadyRoot(
            rootEpoch: epoch, validSources: validSources,
            graphResult: ReadyGraphResult(sources: sources), targets: targets
        )
    }

    func path(_ epoch: WorkspaceCodemapRootEpoch, _ fileID: UUID) -> String {
        pathsByFile[FileLabel(rootEpoch: epoch, fileID: fileID)]!
    }

    func issue(_ issue: WorkspaceCodemapAutomaticSelectionIssue) -> [String: Any] {
        let kind: String
        let source: WorkspaceCodemapAutomaticSelectionSourceIdentity
        switch issue {
        case .emptySources:
            return ["kind": "emptySources"]
        case let .graphNotInitialized(epoch):
            return ["kind": "graphNotInitialized", "root": rootsByEpoch[epoch]!]
        case let .graphUnavailable(epoch):
            return ["kind": "graphUnavailable", "root": rootsByEpoch[epoch]!]
        case let .sourcePending(value): kind = "sourcePending"; source = value
        case let .sourceNotIndexed(value): kind = "sourceNotIndexed"; source = value
        case let .sourceExcluded(value): kind = "sourceExcluded"; source = value
        default:
            fatalError("Unexpected issue outside current, unfenced fixture scope: \(issue)")
        }
        return ["kind": kind, "root": rootsByEpoch[source.rootEpoch]!, "path": path(source.rootEpoch, source.fileID)]
    }

    func source(
        _ source: WorkspaceCodemapAutomaticSelectionGraphSource, epoch: WorkspaceCodemapRootEpoch
    ) -> [String: Any] {
        let state: String
        switch source.state {
        case .covered: state = "covered"
        case .pending: state = "pending"
        case .notIndexed: state = "notIndexed"
        case .excluded: state = "excluded"
        case .fenced, .staleGeneration:
            fatalError("Unexpected source state outside current, unfenced fixture scope")
        }
        return ["path": path(epoch, source.fileID), "state": state, "requestGeneration": source.requestGeneration]
    }

    func output(_ result: WorkspaceCodemapAutomaticSelectionResult) -> [String: Any] {
        let aggregate: [String: Any]
        switch result.aggregateCoverage {
        case .ok:
            aggregate = ["status": result.status.rawValue]
        case let .partial(issues), let .pending(issues), let .unavailable(issues):
            aggregate = ["status": result.status.rawValue, "issues": issues.map(issue)]
        }
        return [
            "roots": result.roots.map { root in
                [
                    "root": rootsByEpoch[root.rootEpoch]!, "status": root.status.rawValue,
                    "sources": root.sources.map { source($0, epoch: root.rootEpoch) },
                    "targets": root.targets.map { path($0.rootEpoch, $0.fileID) }, "issues": root.issues.map(issue)
                ] as [String: Any]
            },
            "aggregateCoverage": aggregate,
            "targets": result.targets
                .map { ["root": rootsByEpoch[$0.rootEpoch]!, "path": path($0.rootEpoch, $0.fileID)] },
            "issues": result.issues.map(issue)
        ]
    }
}

@main
enum Main {
    static func main() throws {
        let document = try JSONDecoder().decode(
            FixtureDocument.self, from: FileHandle.standardInput.readDataToEndOfFile()
        )
        let output = document.cases.map { fixture in
            var run = FixtureRun(rootLabels: document.rootLabels)
            let roots = fixture.roots.map { run.resolve($0) }
            let result = WorkspaceCodemapAutomaticSelectionResult(roots: roots)
            return ["name": fixture.name, "expected": run.output(result)] as [String: Any]
        }
        try FileHandle.standardOutput.write(JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
    }
}
