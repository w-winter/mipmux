import Foundation

struct WorkspaceCodemapSelectionGraphSizePolicy: Hashable {
    static let initial = Self(
        maxNodes: 100_000,
        maxPostings: 2_000_000,
        maxEdges: 1_000_000,
        maxBytes: 192 * 1024 * 1024,
        maxDefinitionCandidates: 4096
    )

    let maxNodes: UInt64
    let maxPostings: UInt64
    let maxEdges: UInt64
    let maxBytes: UInt64
    let maxDefinitionCandidates: UInt64
}
