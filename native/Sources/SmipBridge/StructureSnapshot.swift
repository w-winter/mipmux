import Foundation

/// Operation-owned, settled inventory bindings for the retained RPCE query bodies.
struct WorkspaceCodemapRootEpoch: Hashable {
    let rootID: UUID
    let rootLifetimeID: UUID
}

struct WorkspaceCodemapGraphCatalogCoverage: Hashable {
    let supportedCount: UInt64
    let classifiedCount: UInt64
    let isComplete: Bool
}

struct WorkspaceCodemapGraphSnapshotReceipt: Hashable {
    let inventoryDigest: String
}

enum WorkspaceCodemapGraphSnapshotFreshness: Hashable {
    case current
    case updatesPending
}

enum WorkspaceCodemapGraphUnresolvedReason: Hashable {
    case notIndexedYet
    case missing
    case tooCommon
}

enum StructureSlotState: String {
    case pending, contributed, empty, terminalArtifact, terminalExcluded
}

struct WorkspaceCodemapGraphSlot {
    let standardizedRelativePath: String
    let state: StructureSlotState
}

struct StructureContribution {
    let sortedUniqueDefinitions: [String]
    let sortedUniqueReferences: [String]
}

struct WorkspaceCodemapGraphSnapshotNode {
    let fileID: UUID
    let standardizedRelativePath: String
    let contribution: StructureContribution
}

struct WorkspaceCodemapGraphEdgeEvidence {
    let sourceFileID: UUID
    let targetFileID: UUID
    let matchedNames: [String]
    let candidateCount: UInt64
    let ambiguous: Bool
}

struct WorkspaceCodemapGraphUnresolvedRecord {
    let sourceFileID: UUID
    let referencedName: String
    let reason: WorkspaceCodemapGraphUnresolvedReason
}

struct WorkspaceCodemapGraphCommittedSnapshot {
    let slotsByFileID: [UUID: WorkspaceCodemapGraphSlot]
    let nodesByFileID: [UUID: WorkspaceCodemapGraphSnapshotNode]
    let outgoingEdgesBySource: [UUID: [WorkspaceCodemapGraphEdgeEvidence]]
    let reverseEdgesByTarget: [UUID: [WorkspaceCodemapGraphEdgeEvidence]]
    let unresolvedBySource: [UUID: [WorkspaceCodemapGraphUnresolvedRecord]]
    let coverage: WorkspaceCodemapGraphCatalogCoverage

    func reverseEdges(target: UUID) -> [WorkspaceCodemapGraphEdgeEvidence] {
        reverseEdgesByTarget[target] ?? []
    }
}

struct WorkspaceCodemapGraphPinnedSnapshot {
    let snapshot: WorkspaceCodemapGraphCommittedSnapshot
    let receipt: WorkspaceCodemapGraphSnapshotReceipt
    let freshness: WorkspaceCodemapGraphSnapshotFreshness
    let reconciling: Bool
    let fencedFileIDs: Set<UUID>

    func isFenced(_ fileID: UUID) -> Bool {
        fencedFileIDs.contains(fileID)
    }
}

struct WorkspaceCodemapLogicalPresentationPath {
    let displayPath: String

    init?(rootDisplayName: String, standardizedRelativePath: String) {
        guard !rootDisplayName.isEmpty, !standardizedRelativePath.isEmpty else { return nil }
        displayPath = rootDisplayName + "/" + standardizedRelativePath
    }
}

struct CodeStructureSignatureIssueCoverage {
    var fileIDs = Set<UUID>()
    var rootEpochs = Set<WorkspaceCodemapRootEpoch>()
    var coversAll = false
}

struct StructureRenderedSignature {
    let text: String
    let tokenCount: Int
}

struct StructureSignaturePresentation {
    let renderedEntriesByFileID: [UUID: StructureRenderedSignature]
    let issues: [ToolResultDTOs.CodeStructureReplyDTO.IssueDTO]
    let coverage: CodeStructureSignatureIssueCoverage
}
