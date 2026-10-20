// Retained RPCE declarations and layout; CCCC enforces the configured complexity limits.
// swiftlint:disable cyclomatic_complexity opening_brace
import Foundation

extension SelectionCatalog {
    func exactPathResolutionIssue(
        for userPath: String,
        kind: WorkspaceExactPathLookupKind,
        rootScope: WorkspaceLookupRootScope = .visibleWorkspace
    ) -> PathResolutionIssue? {
        exactPathResolutionIssue(
            for: userPath,
            kind: kind,
            rootRefs: rootRefs(scope: rootScope)
        )
    }

    func exactPathResolutionIssue(
        for userPath: String,
        kind: WorkspaceExactPathLookupKind,
        rootRefs roots: [WorkspaceRootRef]
    ) -> PathResolutionIssue? {
        let trimmedInput = userPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInput.isEmpty else { return .emptyInput }
        if StandardizedPath.containsNUL(trimmedInput) {
            return .invalidPathCharacters(
                input: trimmedInput,
                reason: "embedded NUL (\\0) characters are not allowed"
            )
        }
        let expanded = (trimmedInput as NSString).expandingTildeInPath
        let standardized = StandardizedPath.absolute(expanded)
        guard !standardized.hasPrefix("/") else { return nil }

        guard !roots.isEmpty else { return nil }

        switch WorkspaceAliasResolver.resolve(
            userPath: standardized,
            roots: roots,
            options: RootAliasOptions(requireRemainder: false, allowCompatibilityAlias: true)
        ) {
        case let .ambiguous(alias, matchingRoots):
            return .ambiguousAlias(alias: alias, matchingRoots: matchingRoots)
        case let .bareRoot(root, _):
            switch kind {
            case .folder, .either:
                if rootStatesByID[root.id] != nil { return nil }
            case .file:
                break
            }
        case let .prefixed(root, _, remainder):
            let absolute = StandardizedPath.join(
                standardizedRoot: root.standardizedFullPath,
                standardizedRelativePath: StandardizedPath.relative(remainder)
            )
            if exactRecordExists(standardizedFullPath: absolute, kind: kind) { return nil }
        case .notAliasPrefixed:
            break
        }

        let relative = StandardizedPath.relative(standardized.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        guard !relative.isEmpty else { return nil }
        let matchingRoots = roots.filter { root in
            let absolute = StandardizedPath.join(
                standardizedRoot: root.standardizedFullPath,
                standardizedRelativePath: relative
            )
            return exactRecordExists(standardizedFullPath: absolute, kind: kind)
        }
        guard matchingRoots.count > 1 else { return nil }
        return .ambiguousRootMatch(input: trimmedInput, candidateRoots: matchingRoots)
    }

    func lookupFiles(
        atPaths paths: [String],
        profile: PathLocateProfile = .mcpSelection,
        rootScope: WorkspaceLookupRootScope = .visibleWorkspace
    ) async -> [String: WorkspaceFileRecord] {
        var files: [String: WorkspaceFileRecord] = [:]
        var generalLookupPaths: [String] = []
        for path in paths {
            switch lookupCatalogFileForExplicitRequest(path, rootScope: rootScope) {
            case let .matched(file):
                files[path] = file
                continue
            case .ambiguous, .blocked:
                continue
            case .noCandidate:
                break
            }
            do {
                let outcome = try await materializeExplicitlyRequestedFile(path, rootScope: rootScope)
                switch outcome {
                case let .materialized(file):
                    files[path] = file
                case .ambiguous, .blocked, .unavailable:
                    continue
                case .noCandidate:
                    generalLookupPaths.append(path)
                }
            } catch is CancellationError {
                return files
            } catch {
                // Batch lookup remains best-effort for ordinary materialization failures.
                generalLookupPaths.append(path)
            }
        }
        let requests = generalLookupPaths.map { WorkspacePathLookupRequest(
            userPath: $0,
            profile: profile,
            rootScope: rootScope
        ) }
        let results = await lookupPaths(requests)
        for path in generalLookupPaths where files[path] == nil {
            if let file = results[path]?.file {
                files[path] = file
            }
        }
        return files
    }

    func lookupCatalogFileForExplicitRequest(_ userPath: String,
                                             rootScope: WorkspaceLookupRootScope)
        -> WorkspaceExplicitCatalogFileLookupResult
    {
        lookupCatalogFileForExplicitRequest(userPath, rootRefs: rootRefs(scope: rootScope))
    }

    func lookupCatalogFileForExplicitRequest(
        _ userPath: String,
        rootRefs roots: [WorkspaceRootRef]
    ) -> WorkspaceExplicitCatalogFileLookupResult {
        let trimmed = userPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .noCandidate }
        guard !StandardizedPath.containsNUL(trimmed) else {
            return .blocked
        }

        let expanded = (trimmed as NSString).expandingTildeInPath
        let standardized = StandardizedPath.absolute(expanded)

        if standardized.hasPrefix("/") {
            guard let root = roots
                .filter({ StandardizedPath.isDescendant(standardized, of: $0.standardizedFullPath) })
                .max(by: { $0.standardizedFullPath.count < $1.standardizedFullPath.count })
            else { return .noCandidate }
            let relativePath = String(standardized.dropFirst(root.standardizedFullPath.count))
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard let file = file(rootID: root.id, relativePath: relativePath) else { return .noCandidate }
            return .matched(file)
        }

        switch WorkspaceAliasResolver.resolve(
            userPath: standardized,
            roots: roots,
            options: RootAliasOptions(requireRemainder: true)
        ) {
        case let .prefixed(root, _, remainder):
            guard let file = file(rootID: root.id, relativePath: remainder) else { return .noCandidate }
            return .matched(file)
        case .ambiguous:
            return .ambiguous
        case .bareRoot, .notAliasPrefixed:
            break
        }
        let relativePath = StandardizedPath.relative(standardized)
        guard !relativePath.isEmpty,
              relativePath != "..",
              !relativePath.hasPrefix("../")
        else {
            return .blocked
        }
        let matches = roots.compactMap { file(rootID: $0.id, relativePath: relativePath) }
        guard matches.count <= 1 else {
            return .ambiguous
        }
        guard let match = matches.first else { return .noCandidate }
        return .matched(match)
    }

    func exactRecordExists(standardizedFullPath: String, kind: WorkspaceExactPathLookupKind) -> Bool {
        let absolute = StandardizedPath.absolute(standardizedFullPath)
        switch kind {
        case .file:
            return fileIDsByStandardizedFullPath[absolute] != nil
        case .folder:
            return folderIDsByStandardizedFullPath[absolute].map(isDiscoverableFolderID) ?? false
        case .either:
            return fileIDsByStandardizedFullPath[absolute] != nil ||
                (folderIDsByStandardizedFullPath[absolute].map(isDiscoverableFolderID) ?? false)
        }
    }
}

// swiftlint:enable cyclomatic_complexity opening_brace
