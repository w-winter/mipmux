// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Retained snapshot data; app lookup/coverage projection omitted.
import Foundation

struct WorkspaceFileTreePresentationSnapshot {
    let roots: [WorkspaceFileTreeFolderPresentation]
    let selectedFileIDs: Set<UUID>
    let mode: String
    let showFullPaths: Bool
    let onlyIncludeRootsWithSelectedFiles: Bool
    let includeLegend: Bool
    let showCodeMapMarkers: Bool
    let maxDepth: Int?

    init(
        roots: [WorkspaceFileTreeFolderPresentation],
        selectedFileIDs: Set<UUID>,
        mode: String,
        showFullPaths: Bool,
        onlyIncludeRootsWithSelectedFiles: Bool,
        includeLegend: Bool,
        showCodeMapMarkers: Bool = true,
        maxDepth: Int? = nil
    ) {
        self.roots = roots
        self.selectedFileIDs = selectedFileIDs
        self.mode = mode
        self.showFullPaths = showFullPaths
        self.onlyIncludeRootsWithSelectedFiles = onlyIncludeRootsWithSelectedFiles
        self.includeLegend = includeLegend
        self.showCodeMapMarkers = showCodeMapMarkers
        self.maxDepth = maxDepth
    }
}

struct WorkspaceFileTreeFolderPresentation: Hashable {
    let id: UUID
    let name: String
    let fullPath: String
    let standardizedFullPath: String
    let standardizedRootPath: String
    let children: [WorkspaceFileTreeNodePresentation]
}

struct WorkspaceFileTreeFilePresentation: Hashable {
    let id: UUID
    let name: String
    let fileExtension: String?
    let hasCodeMap: Bool
}

indirect enum WorkspaceFileTreeNodePresentation: Hashable {
    case folder(WorkspaceFileTreeFolderPresentation)
    case file(WorkspaceFileTreeFilePresentation)

    var id: UUID {
        switch self {
        case let .folder(folder): folder.id
        case let .file(file): file.id
        }
    }

    var name: String {
        switch self {
        case let .folder(folder): folder.name
        case let .file(file): file.name
        }
    }
}
