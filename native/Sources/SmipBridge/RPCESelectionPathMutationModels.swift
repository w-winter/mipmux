import Foundation

struct WorkspaceAddSelectionResult: Equatable {
    let selection: StoredSelection
    let invalidPaths: [String]
    let resolvedMap: [String: String]
    let mutated: Bool
    let codemapUnavailable: [String]
}

struct WorkspaceRemoveSelectionResult: Equatable {
    let selection: StoredSelection
    let invalidPaths: [String]
    let resolvedMap: [String: String]
    let mutated: Bool
}

struct WorkspaceDemoteSelectionResult: Equatable {
    let selection: StoredSelection
    let invalidPaths: [String]
    let codemapUnavailable: [String]
    let mutated: Bool
    let validCandidateCount: Int
}
