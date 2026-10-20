// Retained source identifiers and layout; CCCC enforces the configured complexity limits.
// swiftlint:disable identifier_name
import Foundation

// MARK: - Path Match Result Types

/// Pure-value result coming from the background PathMatcher.
/// No actor references – therefore `Sendable` by default.
struct PathMatchLocation {
    let rootPath: String // absolute path of the owning repo root
    let correctedPath: String // final relative path inside that root
}

// MARK: - Immutable Snapshot Types

struct PathMatchCacheIdentity: Hashable {
    let scopeID: UInt64
    let snapshotID: UInt64
}

/// Static part of the snapshot (expensive to build, cached).
/// Immutable, cross-actor-safe snapshot used by PathMatcher and PathMatchWorker.
/// All references to UI/ViewModel types are stripped; uses frozen records only.
struct StaticPathMatchData {
    let filesByFullPath: [String: FileRecord]
    let foldersByFullPath: [String: FolderRecord]
    let rootFolders: [FolderRecord]

    // Case-insensitive dictionaries (no duplicates in original maps)
    let filesByLowerFullPath: [String: FileRecord]
    let foldersByLowerFullPath: [String: FolderRecord]

    /// Matching policy - current default is case-insensitive
    let caseSensitive: Bool

    /// Scope plus snapshot identity used to retain unaffected cached path indexes.
    let cacheIdentity: PathMatchCacheIdentity

    /// Monotonic id to allow callers to compare snapshot generations.
    let id: UInt64

    init(
        filesByFullPath: [String: FileRecord],
        foldersByFullPath: [String: FolderRecord],
        rootFolders: [FolderRecord],
        cacheScopeID: UInt64 = 0,
        id: UInt64,
        caseSensitive: Bool = false
    ) {
        self.filesByFullPath = filesByFullPath
        self.foldersByFullPath = foldersByFullPath
        self.rootFolders = rootFolders
        cacheIdentity = PathMatchCacheIdentity(scopeID: cacheScopeID, snapshotID: id)
        self.id = id

        // Handle potential case-insensitive collisions by keeping the first occurrence
        var filesByLower: [String: FileRecord] = [:]
        for (path, record) in filesByFullPath {
            let lowerPath = path.lowercased()
            if filesByLower[lowerPath] == nil {
                filesByLower[lowerPath] = record
            }
        }
        filesByLowerFullPath = filesByLower

        var foldersByLower: [String: FolderRecord] = [:]
        for (path, record) in foldersByFullPath {
            let lowerPath = path.lowercased()
            if foldersByLower[lowerPath] == nil {
                foldersByLower[lowerPath] = record
            }
        }
        foldersByLowerFullPath = foldersByLower

        self.caseSensitive = caseSensitive
    }
}

/// Immutable snapshot of file hierarchy state for path matching.
/// All references to UI/ViewModel types are stripped; uses frozen records only.
struct PathMatchSnapshot {
    let filesByFullPath: [String: FileRecord]
    let foldersByFullPath: [String: FolderRecord]
    let rootFolders: [FolderRecord]

    // Case-insensitive dictionaries copied from StaticPathMatchData or computed on the fly
    let filesByLowerFullPath: [String: FileRecord]
    let foldersByLowerFullPath: [String: FolderRecord]

    let selectedFileFullPaths: Set<String>

    /// Fully computed indexes – no internal locking, built on the worker actor.
    private let storedIndexes: PathMatchIndexes
    var indexes: PathMatchIndexes {
        storedIndexes
    }

    /// Matching policy flag (current default is case-insensitive)
    let caseSensitive: Bool

    /// Primary initializer used by PathMatchWorker.
    /// Accepts pre-computed indexes from the worker's cache.
    init(
        staticData: StaticPathMatchData,
        selectedFileFullPaths: Set<String>,
        indexes: PathMatchIndexes
    ) {
        filesByFullPath = staticData.filesByFullPath
        foldersByFullPath = staticData.foldersByFullPath
        rootFolders = staticData.rootFolders
        filesByLowerFullPath = staticData.filesByLowerFullPath
        foldersByLowerFullPath = staticData.foldersByLowerFullPath
        self.selectedFileFullPaths = selectedFileFullPaths
        storedIndexes = indexes
        caseSensitive = staticData.caseSensitive
    }

    // MARK: − Convenience helpers

    func fileRecord(forFullPath path: String) -> FileRecord? {
        let std = (path as NSString).standardizingPath
        return fileRecord(forStandardizedFullPath: std)
    }

    func fileRecord(forStandardizedFullPath path: String) -> FileRecord? {
        filesByFullPath[path] ?? filesByLowerFullPath[path.lowercased()]
    }

    func folderRecord(forFullPath path: String) -> FolderRecord? {
        let std = (path as NSString).standardizingPath
        return folderRecord(forStandardizedFullPath: std)
    }

    func folderRecord(forStandardizedFullPath path: String) -> FolderRecord? {
        foldersByFullPath[path] ?? foldersByLowerFullPath[path.lowercased()]
    }
}

extension PathMatchSnapshot {
    func canonical(_ s: String) -> String {
        PathMatchIndexes.canonical(s, caseSensitive: caseSensitive)
    }
}

// swiftlint:enable identifier_name
