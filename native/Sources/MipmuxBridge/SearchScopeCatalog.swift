import Foundation

extension SelectionCatalog {
    private func lookupPath(rootID: UUID, relativePath: String) -> WorkspacePathLookupResult? {
        guard let state = rootStatesByID[rootID] else { return nil }
        let key = StandardizedPath.relative(relativePath)
        let file = file(rootID: rootID, relativePath: key), folder = folder(rootID: rootID, relativePath: key)
        guard file != nil || folder != nil else { return nil }
        return WorkspacePathLookupResult(input: relativePath,
                                         location: WorkspacePathLocation(rootID: rootID,
                                                                         rootPath: state.root.standardizedFullPath,
                                                                         correctedPath: key),
                                         file: file, folder: folder)
    }

    func lookupDiscoverablePath(rootID: UUID, relativePath: String) -> WorkspacePathLookupResult? {
        guard let result = lookupPath(rootID: rootID, relativePath: relativePath),
              isDiscoverableLookupResult(result)
        else { return nil }
        return result
    }

    func lookupDiscoverableCatalogPathForExactAbsoluteSearchScope(
        _ userPath: String,
        rootScope: WorkspaceLookupRootScope
    ) -> WorkspacePathLookupResult? {
        let trimmed = userPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !StandardizedPath.containsNUL(trimmed) else { return nil }
        let expanded = (trimmed as NSString).expandingTildeInPath
        guard expanded.hasPrefix("/") else { return nil }
        let standardizedPath = StandardizedPath.absolute(expanded)
        guard let root = rootRefs(scope: rootScope)
            .filter({ StandardizedPath.isDescendant(standardizedPath, of: $0.standardizedFullPath) })
            .max(by: { $0.standardizedFullPath.count < $1.standardizedFullPath.count })
        else { return nil }
        let relativePath = StandardizedPath.relative(String(standardizedPath.dropFirst(root.standardizedFullPath.count))
            .trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        guard let result = lookupPath(rootID: root.id, relativePath: relativePath),
              isDiscoverableLookupResult(result)
        else { return nil }
        return result
    }

    private func isDiscoverableLookupResult(_ result: WorkspacePathLookupResult) -> Bool {
        if let file = result.file, !isDiscoverableFileID(file.id) { return false }
        if let folder = result.folder, !isDiscoverableFolderID(folder.id) { return false }
        return true
    }
}
