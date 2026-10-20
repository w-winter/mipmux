import Foundation

/// Immutable, caller-scoped catalog. Explicit acquisition outcomes are captured separately from discoverable records.
struct SelectionCatalog {
    struct RootState {
        let root: WorkspaceRootRef
        var fileIDsByRelativePath: [String: UUID] = [:]
        var folderIDsByRelativePath: [String: UUID] = [:]
        var childFileIDsByFolderID: [UUID: Set<UUID>] = [:]
        var childFolderIDsByFolderID: [UUID: Set<UUID>] = [:]
    }

    let roots: [WorkspaceRootRef]
    let filesByID: [UUID: WorkspaceFileRecord]
    let foldersByID: [UUID: WorkspaceFolderRecord]
    let fileIDsByStandardizedFullPath: [String: UUID]
    let folderIDsByStandardizedFullPath: [String: UUID]
    let rootStatesByID: [UUID: RootState]
    let discoverableFiles: Set<UUID>
    let discoverableFolders: Set<UUID>
    let materialization: [String: MaterializationOutcome]
    let snapshot: PathMatchSnapshot

    enum MaterializationOutcome: String {
        case noCandidate, ambiguous, blocked, unavailable, failed
    }

    init(roots: [WorkspaceRootRef], files: [WorkspaceFileRecord], folders: [WorkspaceFolderRecord],
         discoverableFiles: Set<UUID>, discoverableFolders: Set<UUID>,
         materialization: [String: MaterializationOutcome]) {
        self.roots = roots
        self.discoverableFiles = discoverableFiles
        self.discoverableFolders = discoverableFolders
        self.materialization = materialization
        filesByID = Dictionary(uniqueKeysWithValues: files.map { ($0.id, $0) })
        foldersByID = Dictionary(uniqueKeysWithValues: folders.map { ($0.id, $0) })
        fileIDsByStandardizedFullPath = files.reduce(into: [:]) { $0[$1.standardizedFullPath] = $1.id }
        folderIDsByStandardizedFullPath = folders.reduce(into: [:]) { $0[$1.standardizedFullPath] = $1.id }
        var states = Dictionary(uniqueKeysWithValues: roots.map { ($0.id, RootState(root: $0)) })
        for folder in folders {
            states[folder.rootID]!.folderIDsByRelativePath[folder.standardizedRelativePath] = folder.id
            if let parent = folder.parentFolderID {
                states[folder.rootID]!.childFolderIDsByFolderID[parent, default: []].insert(folder.id)
            }
        }
        for file in files {
            states[file.rootID]!.fileIDsByRelativePath[file.standardizedRelativePath] = file.id
            states[file.rootID]!.childFileIDsByFolderID[file.parentFolderID!, default: []].insert(file.id)
        }
        rootStatesByID = states
        snapshot = Self.matchSnapshot(roots: roots, files: files, folders: folders,
                                      discoverableFiles: discoverableFiles, discoverableFolders: discoverableFolders)
    }

    private static func matchSnapshot(roots: [WorkspaceRootRef], files: [WorkspaceFileRecord],
                                      folders: [WorkspaceFolderRecord], discoverableFiles: Set<UUID>,
                                      discoverableFolders: Set<UUID>) -> PathMatchSnapshot {
        let rootsByID = Dictionary(uniqueKeysWithValues: roots.map { ($0.id, $0) })
        var fileRecords: [String: FileRecord] = [:], folderRecords: [String: FolderRecord] = [:]
        for file in files where discoverableFiles.contains(file.id) && fileRecords[file.standardizedFullPath] == nil {
            fileRecords[file.standardizedFullPath] = FrozenFileRecord(
                name: file.name, relativePath: file.standardizedRelativePath, fullPath: file.standardizedFullPath,
                rootFolderPath: rootsByID[file.rootID]!.standardizedFullPath
            )
        }
        for folder in folders
            where discoverableFolders.contains(folder.id) && folderRecords[folder.standardizedFullPath] == nil {
            folderRecords[folder.standardizedFullPath] = FrozenFolderRecord(
                name: folder.name, relativePath: folder.standardizedRelativePath, fullPath: folder.standardizedFullPath,
                rootPath: rootsByID[folder.rootID]!.standardizedFullPath
            )
        }
        let rootFolders: [FolderRecord] = roots.map {
            FrozenFolderRecord(
                name: $0.name,
                relativePath: "",
                fullPath: $0.standardizedFullPath,
                rootPath: $0.standardizedFullPath
            )
        }
        let data = StaticPathMatchData(
            filesByFullPath: fileRecords,
            foldersByFullPath: folderRecords,
            rootFolders: rootFolders,
            id: 0
        )
        return PathMatchSnapshot(staticData: data, selectedFileFullPaths: [], indexes: PathMatchIndexes.build(
            files: fileRecords, folders: folderRecords, caseSensitive: data.caseSensitive
        ))
    }

    func rootRefs(scope _: WorkspaceLookupRootScope) -> [WorkspaceRootRef] {
        roots
    }

    func isDiscoverableFileID(_ id: UUID) -> Bool {
        discoverableFiles.contains(id)
    }

    func isDiscoverableFolderID(_ id: UUID) -> Bool {
        discoverableFolders.contains(id)
    }

    func normalizeUserInputPath(_ path: String) -> String {
        (path as NSString).expandingTildeInPath
    }

    func file(rootID: UUID, relativePath: String) -> WorkspaceFileRecord? {
        rootStatesByID[rootID]?.fileIDsByRelativePath[StandardizedPath.relative(relativePath)].flatMap { filesByID[$0] }
    }

    func folder(rootID: UUID, relativePath: String) -> WorkspaceFolderRecord? {
        rootStatesByID[rootID]?.folderIDsByRelativePath[StandardizedPath.relative(relativePath)]
            .flatMap { foldersByID[$0] }
    }

    func materializeExplicitlyRequestedFile(_ path: String,
                                            rootScope _: WorkspaceLookupRootScope) async throws
        -> WorkspaceExplicitFileMaterializationResult {
        guard (path as NSString).expandingTildeInPath.hasPrefix("/") else { return .noCandidate }
        switch materialization[path]! {
        case .noCandidate: return .noCandidate
        case .ambiguous: return .ambiguous
        case .blocked: return .blocked
        case .unavailable: return .unavailable
        case .failed: throw BridgeFailure("nativeIOFailed")
        }
    }

    func lookupPaths(_ requests: [WorkspacePathLookupRequest]) async -> [String: WorkspacePathLookupResult] {
        var results: [String: WorkspacePathLookupResult] = [:]
        for request in requests {
            if let result = await lookupPath(request, rootRefs: roots) { results[request.userPath] = result }
        }
        return results
    }

    func lookupPath(_ request: WorkspacePathLookupRequest,
                    rootRefs: [WorkspaceRootRef]) async -> WorkspacePathLookupResult? {
        guard let match = PathMatcher.locate(
            userPath: request.userPath,
            options: request.profile.options,
            snapshot: snapshot
        ),
            let root = rootRefs.first(where: { $0.standardizedFullPath == StandardizedPath.absolute(match.rootPath) })
        else { return nil }
        let relative = StandardizedPath.relative(match.correctedPath)
        let file = file(rootID: root.id, relativePath: relative), folder = folder(
            rootID: root.id,
            relativePath: relative
        )
        guard file != nil || folder != nil else { return nil }
        return WorkspacePathLookupResult(input: request.userPath,
                                         location: WorkspacePathLocation(rootID: root.id,
                                                                         rootPath: root.standardizedFullPath,
                                                                         correctedPath: relative),
                                         file: file, folder: folder)
    }
}

extension SelectionCatalog {
    init(wireRoots roots: [Any], outcomes: [Any], paths: [String]) throws {
        let captured = try CapturedSelectionCatalog(roots)
        var materialization: [String: SelectionCatalog.MaterializationOutcome] = [:]
        for raw in outcomes {
            let outcome = try WireObject(raw, keys: ["path", "outcome"])
            let path = try outcome.string("path")
            guard materialization[path] == nil,
                  let status = try SelectionCatalog.MaterializationOutcome(rawValue: outcome.string("outcome"))
            else { throw BridgeFailure("nativeProtocolError") }
            materialization[path] = status
        }
        self.init(roots: captured.roots, files: captured.files, folders: captured.folders,
                  discoverableFiles: captured.discoverableFiles,
                  discoverableFolders: captured.discoverableFolders,
                  materialization: materialization)
        try validateAcquisitionOutcomes(paths: paths)
    }

    private func validateAcquisitionOutcomes(paths: [String]) throws {
        for path in paths {
            let key = path.trimmingCharacters(in: .whitespacesAndNewlines)
            let absolute = StandardizedPath.absolute((key as NSString).expandingTildeInPath)
            guard absolute.hasPrefix("/"), !StandardizedPath.containsNUL(key),
                  roots
                  .contains(where: { StandardizedPath.isDescendant(absolute, of: $0.standardizedFullPath) }),
                  case .noCandidate = lookupCatalogFileForExplicitRequest(key, rootScope: .visibleWorkspace)
            else { continue }
            guard materialization[key] != nil else { throw BridgeFailure("nativeProtocolError") }
        }
    }
}
