// Retained RPCE declarations and layout; CCCC enforces the configured complexity limits.
// swiftlint:disable type_name
import Foundation

enum WorkspaceExactPathLookupKind: Hashable {
    case file
    case folder
    case either
}

struct WorkspaceFolderExpansionResult: Equatable {
    let files: [WorkspaceFileRecord]
    let handled: Bool
    let displayPath: String?
    let issue: PathResolutionIssue?
}

struct WorkspaceResolvedCandidates: Equatable {
    let candidates: [WorkspaceFileRecord]
    let resolvedMap: [String: String]
    let invalidPaths: [String]
}

struct WorkspaceCodemapOnlyCandidates: Equatable {
    let candidates: [WorkspaceFileRecord]
    let resolvedMap: [String: String]
    let invalidPaths: [String]
    let codemapUnavailable: [String]
}

struct WorkspaceFolderRecord: Identifiable, Equatable, Hashable {
    let id: UUID
    let rootID: UUID
    let name: String
    let relativePath: String
    let standardizedRelativePath: String
    let fullPath: String
    let standardizedFullPath: String
    let parentFolderID: UUID?
    let modificationDate: Date?

    init(
        id: UUID = UUID(),
        rootID: UUID,
        name: String,
        relativePath: String,
        fullPath: String,
        parentFolderID: UUID?,
        modificationDate: Date? = nil
    ) {
        self.id = id
        self.rootID = rootID
        self.name = name
        self.relativePath = relativePath
        standardizedRelativePath = StandardizedPath.relative(relativePath)
        self.fullPath = fullPath
        standardizedFullPath = StandardizedPath.absolute(fullPath)
        self.parentFolderID = parentFolderID
        self.modificationDate = modificationDate
    }
}

struct WorkspaceFileRecord: Identifiable, Equatable, Hashable {
    let id: UUID
    let rootID: UUID
    let name: String
    let relativePath: String
    let standardizedRelativePath: String
    let fullPath: String
    let standardizedFullPath: String
    let parentFolderID: UUID?
    let modificationDate: Date?

    init(
        id: UUID = UUID(),
        rootID: UUID,
        name: String,
        relativePath: String,
        fullPath: String,
        parentFolderID: UUID?,
        modificationDate: Date? = nil
    ) {
        self.id = id
        self.rootID = rootID
        self.name = name
        self.relativePath = relativePath
        standardizedRelativePath = StandardizedPath.relative(relativePath)
        self.fullPath = fullPath
        standardizedFullPath = StandardizedPath.absolute(fullPath)
        self.parentFolderID = parentFolderID
        self.modificationDate = modificationDate
    }
}

enum WorkspaceLookupRootScope { case visibleWorkspace }

enum WorkspaceExplicitCatalogFileLookupResult { case matched(WorkspaceFileRecord), ambiguous, blocked, noCandidate }
enum WorkspaceExplicitFileMaterializationResult { case materialized(WorkspaceFileRecord), ambiguous, blocked,
                                                       unavailable, noCandidate
}

struct WorkspacePathLookupRequest {
    let userPath: String; let profile: PathLocateProfile; let rootScope: WorkspaceLookupRootScope
}

struct WorkspacePathLookupResult { let file: WorkspaceFileRecord?; let folder: WorkspaceFolderRecord? }

// swiftlint:enable type_name
