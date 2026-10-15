// RPCE source excerpts with fixture-only wrappers. See receipt.md and provenance.json.
// Keep extracted bodies verbatim; provenance.json verifies their source hashes.
// swiftlint:disable type_name identifier_name duplicate_imports opening_brace vertical_whitespace
import Foundation

struct WorkspaceCodemapAutomaticSelectionSourceIdentity: Hashable {
    let rootEpoch: WorkspaceCodemapRootEpoch
    let fileID: UUID
    let catalogGeneration: UInt64
    let requestGeneration: UInt64
}

struct WorkspaceCodemapAutomaticSelectionTarget: Hashable {
    let rootEpoch: WorkspaceCodemapRootEpoch
    let fileID: UUID
    let catalogGeneration: UInt64
    let requestGeneration: UInt64
    let logicalPath: WorkspaceCodemapLogicalPresentationPath
}

struct WorkspaceCodemapAutomaticSelectionGraphSeed: Hashable {
    let fileID: UUID
    let requestGeneration: UInt64
}

enum WorkspaceCodemapAutomaticSelectionGraphSourceState: Hashable {
    case covered
    case pending
    case notIndexed
    case excluded
    case fenced
    case staleGeneration(expected: UInt64, committed: UInt64?)
}

struct WorkspaceCodemapAutomaticSelectionGraphSource: Hashable {
    let fileID: UUID
    let requestGeneration: UInt64
    let state: WorkspaceCodemapAutomaticSelectionGraphSourceState
}

struct WorkspaceCodemapAutomaticSelectionGraphTarget: Hashable {
    let fileID: UUID
    let requestGeneration: UInt64
    let standardizedRelativePath: String
}

enum WorkspaceCodemapAutomaticSelectionBudgetReason: Hashable {
    case sourceLimit(attempted: Int, limit: Int)
    case uniqueSourceLimit(attempted: Int, limit: Int)
    case sourceIssueLimit(attempted: Int, limit: Int)
    case rootLimit(attempted: Int, limit: Int)
    case targetDemandLimit(attempted: Int, limit: Int)
    case targetLimit(attempted: Int, limit: Int)
    case resolutionLimit(attempted: Int, limit: Int)
    case referenceFailureLimit(attempted: Int, limit: Int)
    case byteLimit(attempted: Int, limit: Int)
    case accountingOverflow
}

enum WorkspaceCodemapAutomaticSelectionStatus: String, Hashable {
    case ok
    case partial
    case pending
    case unavailable
}

enum WorkspaceCodemapAutomaticSelectionIssue: Equatable {
    case emptySources
    case sourceOutsideRootScope(WorkspaceCodemapAutomaticSelectionSourceIdentity)
    case sourceNotCataloged(WorkspaceCodemapAutomaticSelectionSourceIdentity)
    case sourcePending(WorkspaceCodemapAutomaticSelectionSourceIdentity)
    case sourceNotIndexed(WorkspaceCodemapAutomaticSelectionSourceIdentity)
    case sourceExcluded(WorkspaceCodemapAutomaticSelectionSourceIdentity)
    case sourceFenced(WorkspaceCodemapAutomaticSelectionSourceIdentity)
    case sourceGenerationChanged(
        WorkspaceCodemapAutomaticSelectionSourceIdentity,
        committedGeneration: UInt64?
    )
    case rootEpochChanged(WorkspaceCodemapRootEpoch)
    case rootScopeChanged
    case graphNotInitialized(WorkspaceCodemapRootEpoch)
    case updatesPending(WorkspaceCodemapRootEpoch)
    case reconciling(WorkspaceCodemapRootEpoch)
    case graphUnavailable(WorkspaceCodemapRootEpoch)
    case graphRevoked(WorkspaceCodemapRootEpoch, WorkspaceCodemapGraphRevocationReason)
    case targetNotCataloged(rootEpoch: WorkspaceCodemapRootEpoch, fileID: UUID)
    case targetGenerationChanged(rootEpoch: WorkspaceCodemapRootEpoch, fileID: UUID)
    case targetLogicalPathUnavailable(rootEpoch: WorkspaceCodemapRootEpoch, fileID: UUID)
    case targetDemandPending(rootEpoch: WorkspaceCodemapRootEpoch, fileID: UUID)
    case targetDemandUnavailable(
        rootEpoch: WorkspaceCodemapRootEpoch,
        fileID: UUID,
        reason: WorkspaceCodemapArtifactDemandUnavailableReason
    )
    case receiptInvalid(rootEpoch: WorkspaceCodemapRootEpoch, reason: WorkspaceCodemapGraphReceiptInvalidReason?)
    case budget(WorkspaceCodemapAutomaticSelectionBudgetReason)
}

enum WorkspaceCodemapAutomaticSelectionAggregateCoverage: Equatable {
    case ok
    case partial([WorkspaceCodemapAutomaticSelectionIssue])
    case pending([WorkspaceCodemapAutomaticSelectionIssue])
    case unavailable([WorkspaceCodemapAutomaticSelectionIssue])

    var status: WorkspaceCodemapAutomaticSelectionStatus {
        switch self {
        case .ok: .ok
        case .partial: .partial
        case .pending: .pending
        case .unavailable: .unavailable
        }
    }
}

struct WorkspaceCodemapAutomaticSelectionRootResult: Equatable {
    let rootEpoch: WorkspaceCodemapRootEpoch
    let status: WorkspaceCodemapAutomaticSelectionStatus
    let targets: [WorkspaceCodemapAutomaticSelectionTarget]
    let sources: [WorkspaceCodemapAutomaticSelectionGraphSource]
    let issues: [WorkspaceCodemapAutomaticSelectionIssue]
    let coverage: WorkspaceCodemapGraphCatalogCoverage?
    let graphTargetCount: Int
    let graphResolutionCount: Int
    let graphReferenceFailureCount: Int
    let graphByteCount: Int
    let receipt: WorkspaceCodemapAutomaticSelectionRootReceipt?
}

struct WorkspaceCodemapAutomaticSelectionResult: Equatable {
    let roots: [WorkspaceCodemapAutomaticSelectionRootResult]
    let aggregateCoverage: WorkspaceCodemapAutomaticSelectionAggregateCoverage
    let receipt: WorkspaceCodemapAutomaticSelectionReceipt?

    init(
        roots: [WorkspaceCodemapAutomaticSelectionRootResult],
        aggregateCoverage: WorkspaceCodemapAutomaticSelectionAggregateCoverage? = nil,
        receipt: WorkspaceCodemapAutomaticSelectionReceipt? = nil
    ) {
        self.roots = roots.sorted { workspaceCodemapRootEpochPrecedes($0.rootEpoch, $1.rootEpoch) }
        self.aggregateCoverage = aggregateCoverage ?? Self.aggregate(for: self.roots)
        self.receipt = receipt
    }

    var status: WorkspaceCodemapAutomaticSelectionStatus {
        aggregateCoverage.status
    }

    /// Useful targets survive mixed-root partial, pending, and unavailable results.
    var targets: [WorkspaceCodemapAutomaticSelectionTarget] {
        roots.flatMap(\.targets).sorted(by: automaticSelectionTargetPrecedes)
    }

    var issues: [WorkspaceCodemapAutomaticSelectionIssue] {
        roots.flatMap(\.issues).sorted(by: automaticSelectionIssuePrecedes)
    }

    private static func aggregate(
        for roots: [WorkspaceCodemapAutomaticSelectionRootResult]
    ) -> WorkspaceCodemapAutomaticSelectionAggregateCoverage {
        guard !roots.isEmpty else { return .unavailable([.emptySources]) }
        let issues = roots.flatMap(\.issues).sorted(by: automaticSelectionIssuePrecedes)
        let hasTargets = roots.contains { !$0.targets.isEmpty }
        if roots.allSatisfy({ $0.status == .ok }) { return .ok }
        if hasTargets { return .partial(issues) }
        if roots.contains(where: { $0.status == .pending || $0.status == .partial }) {
            return .pending(issues)
        }
        return .unavailable(issues)
    }
}

func workspaceCodemapRootEpochPrecedes(
    _ lhs: WorkspaceCodemapRootEpoch,
    _ rhs: WorkspaceCodemapRootEpoch
) -> Bool {
    if lhs.rootID != rhs.rootID { return lhs.rootID.uuidString < rhs.rootID.uuidString }
    return lhs.rootLifetimeID.uuidString < rhs.rootLifetimeID.uuidString
}

func automaticSelectionTargetPrecedes(
    _ lhs: WorkspaceCodemapAutomaticSelectionTarget,
    _ rhs: WorkspaceCodemapAutomaticSelectionTarget
) -> Bool {
    if lhs.rootEpoch != rhs.rootEpoch {
        return workspaceCodemapRootEpochPrecedes(lhs.rootEpoch, rhs.rootEpoch)
    }
    if lhs.logicalPath.displayPath != rhs.logicalPath.displayPath {
        return lhs.logicalPath.displayPath.utf8.lexicographicallyPrecedes(rhs.logicalPath.displayPath.utf8)
    }
    return lhs.fileID.uuidString < rhs.fileID.uuidString
}

func automaticSelectionIssuePrecedes(
    _ lhs: WorkspaceCodemapAutomaticSelectionIssue,
    _ rhs: WorkspaceCodemapAutomaticSelectionIssue
) -> Bool {
    String(reflecting: lhs) < String(reflecting: rhs)
}

import Darwin
import Foundation

/// Canonical orderings shared by the root-local graph ledger and the selection graph.
///
/// Both orderings are byte-for-byte equivalent to the historical definitions
/// (`String.utf8.lexicographicallyPrecedes` and `UUID.uuidString` comparison) but avoid generic
/// UTF-8 view iteration and the `uuidString` allocation, which dominated graph-index profiles.
enum WorkspaceCodemapGraphOrdering {
    /// Unsigned byte-wise lexicographic order of the UTF-8 encodings. Shorter prefixes precede.
    @inline(__always)
    static func utf8Precedes(_ lhs: String, _ rhs: String) -> Bool {
        let fastResult: Bool?? = lhs.utf8.withContiguousStorageIfAvailable { left in
            rhs.utf8.withContiguousStorageIfAvailable { right in
                bytesPrecede(UnsafeRawBufferPointer(left), UnsafeRawBufferPointer(right))
            }
        }
        if let outer = fastResult, let result = outer { return result }
        return lhs.utf8.lexicographicallyPrecedes(rhs.utf8)
    }

    /// Equivalent to `lhs.uuidString < rhs.uuidString`: the canonical string is fixed-width
    /// uppercase hexadecimal with dashes at fixed offsets, so its order is the raw byte order.
    @inline(__always)
    static func uuidPrecedes(_ lhs: UUID, _ rhs: UUID) -> Bool {
        withUnsafeBytes(of: lhs.uuid) { left in
            withUnsafeBytes(of: rhs.uuid) { right in
                memcmp(left.baseAddress!, right.baseAddress!, 16) < 0
            }
        }
    }

    @inline(__always)
    private static func bytesPrecede(_ lhs: UnsafeRawBufferPointer, _ rhs: UnsafeRawBufferPointer) -> Bool {
        let common = Swift.min(lhs.count, rhs.count)
        if common > 0, let left = lhs.baseAddress, let right = rhs.baseAddress {
            let comparison = memcmp(left, right, common)
            if comparison != 0 { return comparison < 0 }
        }
        return lhs.count < rhs.count
    }
}

enum OriginalSourceClassification {
    static func classify(
        query: WorkspaceCodemapAutomaticSelectionGraphQuery,
        pinned: Pinned
    ) -> [WorkspaceCodemapAutomaticSelectionGraphSource] {
        let snapshot = pinned.snapshot
            let groupedSeeds = Dictionary(grouping: query.sources, by: \.fileID)
            let sourceIDs = Set(groupedSeeds.keys)
            let orderedSourceIDs = groupedSeeds.keys.sorted {
                Self.fileIDPrecedes($0, $1, snapshot: snapshot)
            }
            var sources: [WorkspaceCodemapAutomaticSelectionGraphSource] = []

            for fileID in orderedSourceIDs {
                let seeds = groupedSeeds[fileID] ?? []
                let requestedGenerations = Set(seeds.map(\.requestGeneration))
                let requestedGeneration = requestedGenerations.min() ?? 0
                let slot = snapshot.slotsByFileID[fileID]
                let state: WorkspaceCodemapAutomaticSelectionGraphSourceState = if requestedGenerations.count != 1 {
                    .staleGeneration(
                        expected: requestedGeneration,
                        committed: slot?.requestGeneration
                    )
                } else if pinned.isFenced(fileID) {
                    .fenced
                } else if let slot {
                    if slot.requestGeneration != requestedGeneration ||
                        slot.pathGeneration != requestedGeneration
                    {
                        .staleGeneration(
                            expected: requestedGeneration,
                            committed: slot.requestGeneration
                        )
                    } else {
                        switch slot.state {
                        case .pending:
                            .pending
                        case .contributed, .empty:
                            .covered
                        case .terminalArtifact, .terminalExcluded:
                            .excluded
                        }
                    }
                } else {
                    .notIndexed
                }
                sources.append(.init(
                    fileID: fileID,
                    requestGeneration: requestedGeneration,
                    state: state
                ))
            }
        return sources
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
        nodes: PersistentHashMap<UUID, WorkspaceCodemapGraphSnapshotNode>
    ) -> Bool {
        let left = nodes[lhs]?.standardizedRelativePath ?? ""
        let right = nodes[rhs]?.standardizedRelativePath ?? ""
        if left != right { return utf8Precedes(left, right) }
        return WorkspaceCodemapGraphOrdering.uuidPrecedes(lhs, rhs)
    }


    private static func utf8Precedes(_ lhs: String, _ rhs: String) -> Bool {
        WorkspaceCodemapGraphOrdering.utf8Precedes(lhs, rhs)
    }
}

// swiftlint:disable:next cyclomatic_complexity
func resolveReadyRoot(
    rootEpoch: WorkspaceCodemapRootEpoch,
    validSources: [WorkspaceCodemapAutomaticSelectionSourceIdentity],
    graphResult: ReadyGraphResult,
    targets: [WorkspaceCodemapAutomaticSelectionTarget]
) -> WorkspaceCodemapAutomaticSelectionRootResult {
    let sourceIssues: [WorkspaceCodemapAutomaticSelectionIssue] = []
    let rootReceipt: WorkspaceCodemapAutomaticSelectionRootReceipt? = WorkspaceCodemapAutomaticSelectionRootReceipt()
                var issues = sourceIssues
                for graphSource in graphResult.sources {
                    guard let source = validSources.first(where: { $0.fileID == graphSource.fileID }) else { continue }
                    switch graphSource.state {
                    case .covered:
                        break
                    case .pending:
                        issues.append(.sourcePending(source))
                    case .notIndexed:
                        issues.append(.sourceNotIndexed(source))
                    case .excluded:
                        issues.append(.sourceExcluded(source))
                    case .fenced:
                        issues.append(.sourceFenced(source))
                    case let .staleGeneration(_, committed):
                        issues.append(.sourceGenerationChanged(source, committedGeneration: committed))
                    }
                }

                let hasPendingSource = graphResult.sources.contains {
                    $0.state == .pending || $0.state == .notIndexed
                }
                let status: WorkspaceCodemapAutomaticSelectionStatus = if !targets.isEmpty, !issues.isEmpty {
                    .partial
                } else if hasPendingSource || graphResult.reconciling {
                    targets.isEmpty ? .pending : .partial
                } else if rootReceipt == nil {
                    .unavailable
                } else {
                    .ok
                }
    return makeRootResult(
        rootEpoch: rootEpoch, status: status, targets: targets,
        sources: graphResult.sources, issues: issues, receipt: rootReceipt
    )
}
// swiftlint:enable type_name identifier_name duplicate_imports opening_brace vertical_whitespace
