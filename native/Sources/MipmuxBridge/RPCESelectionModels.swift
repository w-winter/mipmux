import Foundation

/// RPCE selection state; the native boundary accepts canonical captured state, not saved desktop formats.
struct StoredSelection: Equatable, Hashable {
    let selectedPaths: [String]
    let manualCodemapPaths: [String]
    let slices: [String: [LineRange]]
    let codemapAutoEnabled: Bool

    init(
        selectedPaths: [String] = [],
        manualCodemapPaths: [String] = [],
        slices: [String: [LineRange]] = [:],
        codemapAutoEnabled: Bool = true
    ) {
        self.selectedPaths = selectedPaths
        self.manualCodemapPaths = manualCodemapPaths
        self.slices = slices
        self.codemapAutoEnabled = codemapAutoEnabled
    }

    var isEmptyForSelectedFileTree: Bool {
        selectedPaths.isEmpty && manualCodemapPaths.isEmpty && slices.isEmpty
    }
}

enum WorkspacePreResolvedFullFileMutationMode {
    case add
    case remove
}

enum WorkspacePreResolvedSelectionTargetState: Equatable {
    case full
    case codemapOnly
    case unselected
}
