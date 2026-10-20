// Retained RPCE declarations and layout; CCCC enforces the configured complexity limits.
// swiftlint:disable cyclomatic_complexity function_body_length large_tuple opening_brace
import Foundation

extension SelectionCatalog {
    func resolveFolderInput(
        _ path: String,
        rootScope: WorkspaceLookupRootScope = .visibleWorkspace,
        profile: PathLocateProfile = .mcpSelection
    ) async -> (folder: WorkspaceFolderRecord?, displayPath: String?, issue: PathResolutionIssue?) {
        await resolveFolderInput(
            path,
            rootScope: rootScope,
            profile: profile,
            rootRefs: rootRefs(scope: rootScope)
        )
    }

    func resolveFolderInput(
        _ path: String,
        rootScope: WorkspaceLookupRootScope,
        profile: PathLocateProfile,
        rootRefs roots: [WorkspaceRootRef],
        validateIssue: Bool = true,
        allowGeneralLookupFallback: Bool = true
    ) async -> (folder: WorkspaceFolderRecord?, displayPath: String?, issue: PathResolutionIssue?) {
        let cleaned = normalizeUserInputPath(path).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return (nil, nil, .emptyInput) }

        if validateIssue,
           let issue = exactPathResolutionIssue(for: cleaned, kind: .folder, rootRefs: roots)
        {
            return (nil, nil, issue)
        }

        if let result = resolveAbsoluteFolderInput(cleaned, roots: roots) { return result }

        switch WorkspaceAliasResolver.resolve(
            userPath: cleaned,
            roots: roots,
            options: RootAliasOptions(requireRemainder: false)
        ) {
        case let .bareRoot(root, _):
            if let folder = rootFolderRecord(rootID: root.id) {
                return (folder, ClientPathFormatter.displayPath(root: root, relativePath: "", visibleRoots: roots), nil)
            }
        case let .prefixed(root, _, remainder):
            if let folder = folder(rootID: root.id, relativePath: remainder), isDiscoverableFolderID(folder.id) {
                return (
                    folder,
                    ClientPathFormatter
                        .displayPath(root: root, relativePath: folder.standardizedRelativePath, visibleRoots: roots),
                    nil
                )
            }
        case let .ambiguous(alias, matchingRoots):
            return (nil, nil, .ambiguousAlias(alias: alias, matchingRoots: matchingRoots))
        case .notAliasPrefixed:
            break
        }

        let relative = StandardizedPath.relative(cleaned)
        let directRelativeMatches = roots.compactMap { root -> (WorkspaceRootRef, WorkspaceFolderRecord)? in
            guard let folder = folder(rootID: root.id, relativePath: relative),
                  isDiscoverableFolderID(folder.id) else { return nil }
            return (root, folder)
        }
        if directRelativeMatches.count == 1, let match = directRelativeMatches.first {
            return (
                match.1,
                ClientPathFormatter.displayPath(
                    root: match.0,
                    relativePath: match.1.standardizedRelativePath,
                    visibleRoots: roots
                ),
                nil
            )
        }

        guard allowGeneralLookupFallback else { return (nil, nil, nil) }
        let lookup = await lookupPath(
            WorkspacePathLookupRequest(userPath: cleaned, profile: profile, rootScope: rootScope),
            rootRefs: roots
        )
        if let folder = lookup?.folder,
           let root = roots.first(where: { $0.id == folder.rootID })
        {
            return (
                folder,
                ClientPathFormatter
                    .displayPath(root: root, relativePath: folder.standardizedRelativePath, visibleRoots: roots),
                nil
            )
        }
        return (nil, nil, nil)
    }

    private func resolveAbsoluteFolderInput(_ cleaned: String, roots: [WorkspaceRootRef])
        -> (folder: WorkspaceFolderRecord?, displayPath: String?, issue: PathResolutionIssue?)?
    {
        if cleaned.hasPrefix("/") {
            if let folderID = folderIDsByStandardizedFullPath[StandardizedPath.absolute(cleaned)],
               isDiscoverableFolderID(folderID),
               let folder = foldersByID[folderID],
               let root = roots.first(where: { $0.id == folder.rootID })
            {
                return (
                    folder,
                    ClientPathFormatter
                        .displayPath(root: root, relativePath: folder.standardizedRelativePath, visibleRoots: roots),
                    nil
                )
            }
            let pseudoAlias = cleaned.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            switch WorkspaceAliasResolver.resolve(
                userPath: pseudoAlias,
                roots: roots,
                options: RootAliasOptions(requireRemainder: false)
            ) {
            case let .bareRoot(root, _):
                if let folder = rootFolderRecord(rootID: root.id) {
                    return (
                        folder,
                        ClientPathFormatter.displayPath(root: root, relativePath: "", visibleRoots: roots),
                        nil
                    )
                }
            case let .prefixed(root, _, remainder):
                if let folder = folder(rootID: root.id, relativePath: remainder), isDiscoverableFolderID(folder.id) {
                    return (
                        folder,
                        ClientPathFormatter
                            .displayPath(
                                root: root,
                                relativePath: folder.standardizedRelativePath,
                                visibleRoots: roots
                            ),
                        nil
                    )
                }
            case let .ambiguous(alias, matchingRoots):
                return (nil, nil, .ambiguousAlias(alias: alias, matchingRoots: matchingRoots))
            case .notAliasPrefixed:
                break
            }
        }

        return nil
    }

    func expandFolderInputToFiles(
        _ path: String,
        rootScope: WorkspaceLookupRootScope = .visibleWorkspace,
        profile: PathLocateProfile = .mcpSelection
    ) async -> WorkspaceFolderExpansionResult {
        let resolution = await resolveFolderInput(path, rootScope: rootScope, profile: profile)
        if let folder = resolution.folder {
            return WorkspaceFolderExpansionResult(
                files: descendantFiles(in: folder.id),
                handled: true,
                displayPath: resolution.displayPath,
                issue: nil
            )
        }
        if let issue = resolution.issue {
            return WorkspaceFolderExpansionResult(files: [], handled: false, displayPath: nil, issue: issue)
        }
        return WorkspaceFolderExpansionResult(
            files: [],
            handled: false,
            displayPath: nil,
            issue: .unresolved(input: path)
        )
    }

    func rootFolderRecord(rootID: UUID) -> WorkspaceFolderRecord? {
        guard let state = rootStatesByID[rootID],
              let folderID = state.folderIDsByRelativePath[""]
        else { return nil }
        return foldersByID[folderID]
    }

    func descendantFiles(in folderID: UUID) -> [WorkspaceFileRecord] {
        guard let folder = foldersByID[folderID], let state = rootStatesByID[folder.rootID] else { return [] }
        let ids = descendantFileIDs(in: folderID, state: state)
        return ids.compactMap { filesByID[$0] }
            .sorted { $0.standardizedRelativePath < $1.standardizedRelativePath }
    }

    func descendantFileIDs(in folderID: UUID, state: RootState) -> Set<UUID> {
        var fileIDs = Set((state.childFileIDsByFolderID[folderID] ?? []).filter(isDiscoverableFileID))
        for childFolderID in (state.childFolderIDsByFolderID[folderID] ?? []).filter(isDiscoverableFolderID) {
            fileIDs.formUnion(descendantFileIDs(in: childFolderID, state: state))
        }
        return fileIDs
    }
}

// swiftlint:enable cyclomatic_complexity function_body_length large_tuple opening_brace
