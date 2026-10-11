import Foundation

struct WorkspaceSelectionSliceInput: Equatable {
    let path: String
    let ranges: [LineRange]
}

struct WorkspaceBuildSelectionResult: Equatable {
    let selection: StoredSelection
    let invalidPaths: [String]
    let codemapUnavailable: [String]
}

struct WorkspaceSliceSelectionMutationResult: Equatable {
    let selection: StoredSelection
    let invalidPaths: [String]
    let resolvedMap: [String: String]
    let mutated: Bool
}
