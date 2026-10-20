// Retained RPCE declarations and layout; CCCC enforces the configured complexity limits.
// swiftlint:disable large_tuple opening_brace statement_position
import Foundation
import RepoPromptCodeMapCore

struct RPCESelectionCandidateResolver {
    let store: SelectionCatalog

    func resolveSelectionCandidates(paths: [String], rawPaths: [String], expandFolders: Bool,
                                    allowEmptyFolderExpansion: Bool = false,
                                    rootScope: WorkspaceLookupRootScope = .visibleWorkspace) async
        -> WorkspaceResolvedCandidates
    {
        let input = preflight(paths: paths, rawPaths: rawPaths, expandFolders: expandFolders, rootScope: rootScope)
        let resolved = await store.lookupFiles(atPaths: input.keys, rootScope: rootScope)
        var result = CandidateCollection(invalidPaths: input.invalid)
        for key in input.keys {
            let raw = input.rawLookup[key] ?? key
            if let file = resolved[key] {
                result.append(file)
                if result.resolvedMap[raw] == nil { result.resolvedMap[raw] = displayPath(
                    for: file,
                    rootScope: rootScope
                ) }
            } else if expandFolders {
                let folder = await store.expandFolderInputToFiles(key, rootScope: rootScope)
                includeFullFolder(folder, key: key, raw: raw, allowEmpty: allowEmptyFolderExpansion, result: &result)
            } else { result.invalidPaths.append(raw) }
        }
        return WorkspaceResolvedCandidates(
            candidates: result.candidates,
            resolvedMap: result.resolvedMap,
            invalidPaths: result.invalidPaths
        )
    }

    func resolveCodemapOnlyCandidates(paths: [String], rawPaths: [String], expandFolders: Bool,
                                      rootScope: WorkspaceLookupRootScope = .visibleWorkspace) async
        -> WorkspaceCodemapOnlyCandidates
    {
        let input = preflight(paths: paths, rawPaths: rawPaths, expandFolders: expandFolders, rootScope: rootScope)
        let resolved = await store.lookupFiles(atPaths: input.keys, rootScope: rootScope)
        var result = CandidateCollection(invalidPaths: input.invalid)
        for key in input.keys {
            let raw = input.rawLookup[key] ?? key
            if let file = resolved[key] {
                includeCodemapFile(file, raw: raw, rootScope: rootScope, result: &result)
            } else if expandFolders {
                let folder = await store.expandFolderInputToFiles(key, rootScope: rootScope)
                includeCodemapFolder(folder, key: key, raw: raw, result: &result)
            } else { result.invalidPaths.append(raw) }
        }
        return WorkspaceCodemapOnlyCandidates(candidates: result.candidates, resolvedMap: result.resolvedMap,
                                              invalidPaths: result.invalidPaths,
                                              codemapUnavailable: result.codemapUnavailable)
    }

    private func preflight(
        paths: [String],
        rawPaths: [String],
        expandFolders: Bool,
        rootScope: WorkspaceLookupRootScope
    )
        -> (rawLookup: [String: String], keys: [String], invalid: [String])
    {
        let rawLookup = rawLookup(rawPaths, matching: paths), roots = store.rootRefs(scope: rootScope)
        var invalid: [String] = [], keys: [String] = []
        for key in orderedInputs(paths) {
            let raw = rawLookup[key] ?? key
            if let issue = store.exactPathResolutionIssue(
                for: key,
                kind: expandFolders ? .either : .file,
                rootScope: rootScope
            ) {
                invalid.append(pathResolutionMessage(for: issue, rawPath: raw))
            } else if isAbsolutePathOutsideRoots(key, roots: roots) {
                invalid.append(raw)
            } else { keys.append(key) }
        }
        return (rawLookup, keys, invalid)
    }

    private func includeFullFolder(_ folder: WorkspaceFolderExpansionResult, key: String, raw: String,
                                   allowEmpty: Bool, result: inout CandidateCollection)
    {
        guard folder.handled else {
            result.invalidPaths.append(folder.issue.map { pathResolutionMessage(for: $0, rawPath: raw) } ?? raw)
            return
        }
        if folder.files.isEmpty, !allowEmpty {
            result.invalidPaths.append(folder.issue.map { pathResolutionMessage(for: $0, rawPath: raw) } ?? raw)
        } else {
            for file in folder.files {
                result.append(file)
            }
            result.resolvedMap[raw] = result.resolvedMap[raw] ?? (folder.displayPath ?? key)
        }
    }

    private func includeCodemapFile(_ file: WorkspaceFileRecord, raw: String, rootScope: WorkspaceLookupRootScope,
                                    result: inout CandidateCollection)
    {
        let display = displayPath(for: file, rootScope: rootScope)
        if Self.supportsCodemap(file) { result.append(file) }
        else { result.codemapUnavailable.append("codemap unavailable: \(display)") }
        if result.resolvedMap[raw] == nil { result.resolvedMap[raw] = display }
    }

    private func includeCodemapFolder(_ folder: WorkspaceFolderExpansionResult, key: String, raw: String,
                                      result: inout CandidateCollection)
    {
        guard folder.handled, !folder.files.isEmpty else {
            result.invalidPaths.append(folder.issue.map { pathResolutionMessage(for: $0, rawPath: raw) } ?? raw)
            return
        }
        var supported = 0, unsupported = 0
        for file in folder.files {
            if Self.supportsCodemap(file) {
                result.append(file)
                supported += 1
            } else { unsupported += 1 }
        }
        if unsupported > 0, supported == 0 {
            result.codemapUnavailable.append("codemap unavailable: \(raw) (no supported files)")
        } else if unsupported > 0 {
            result.codemapUnavailable
                .append("codemap unavailable: \(unsupported) file(s) in \(raw) skipped (unsupported)")
        }
        result.resolvedMap[raw] = result.resolvedMap[raw] ?? (folder.displayPath ?? key)
    }

    private struct CandidateCollection {
        var candidates: [WorkspaceFileRecord] = []
        var resolvedMap: [String: String] = [:]
        var invalidPaths: [String]
        var codemapUnavailable: [String] = []
        private var seen: Set<String> = []

        init(invalidPaths: [String]) {
            self.invalidPaths = invalidPaths
        }

        mutating func append(_ file: WorkspaceFileRecord) {
            if seen.insert(file.standardizedFullPath).inserted { candidates.append(file) }
        }
    }

    private func orderedInputs(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        for path in paths {
            let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { continue }
            ordered.append(trimmed)
        }
        return ordered
    }

    private func rawLookup(_ rawPaths: [String]) -> [String: String] {
        var lookup: [String: String] = [:]
        for raw in rawPaths {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, lookup[trimmed] == nil else { continue }
            lookup[trimmed] = raw
        }
        return lookup
    }

    private func rawLookup(_ rawPaths: [String], matching paths: [String]) -> [String: String] {
        var lookup = rawLookup(rawPaths)
        let orderedPaths = orderedInputs(paths)
        let orderedRawPaths = orderedInputs(rawPaths)
        guard orderedPaths.count == orderedRawPaths.count else { return lookup }
        for (path, raw) in zip(orderedPaths, orderedRawPaths) {
            lookup[path] = raw
        }
        return lookup
    }

    private func isAbsolutePathOutsideRoots(
        _ path: String,
        roots: [WorkspaceRootRef]
    ) -> Bool {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let expanded = (trimmed as NSString).expandingTildeInPath
        guard expanded.hasPrefix("/") else { return false }
        let standardized = StandardizedPath.absolute(expanded)
        return !roots.contains { root in
            standardized == root.standardizedFullPath
                || StandardizedPath.isDescendant(standardized, of: root.standardizedFullPath)
        }
    }

    private func pathResolutionMessage(
        for issue: PathResolutionIssue,
        rawPath: String
    ) -> String {
        switch issue {
        case .emptyInput:
            PathResolutionIssueRenderer.message(for: issue)
        case let .invalidPathCharacters(_, reason):
            PathResolutionIssueRenderer.message(for: .invalidPathCharacters(input: rawPath, reason: reason))
        case let .ambiguousAlias(alias, matchingRoots):
            PathResolutionIssueRenderer.message(for: .ambiguousAlias(alias: alias, matchingRoots: matchingRoots))
        case let .ambiguousRootMatch(_, candidateRoots):
            PathResolutionIssueRenderer.message(for: .ambiguousRootMatch(
                input: rawPath,
                candidateRoots: candidateRoots
            ))
        case let .pathOutsideWorkspace(_, visibleRoots):
            PathResolutionIssueRenderer.message(for: .pathOutsideWorkspace(input: rawPath, visibleRoots: visibleRoots))
        case let .destinationOutsideSourceRoot(_, sourceRoot):
            PathResolutionIssueRenderer.message(for: .destinationOutsideSourceRoot(
                input: rawPath,
                sourceRoot: sourceRoot
            ))
        case .unsupportedPseudoAbsoluteAlias:
            PathResolutionIssueRenderer.message(for: .unsupportedPseudoAbsoluteAlias(input: rawPath))
        case .unresolved:
            PathResolutionIssueRenderer.message(for: .unresolved(input: rawPath))
        }
    }

    static func supportsCodemap(_ file: WorkspaceFileRecord) -> Bool {
        let ext = (file.name as NSString).pathExtension.lowercased()
        guard !ext.isEmpty else { return false }
        return CodeMapSyntaxEngine.supportsCodeMap(fileExtension: ext)
    }

    private func displayPath(
        for file: WorkspaceFileRecord,
        rootScope: WorkspaceLookupRootScope
    ) -> String {
        let roots = store.rootRefs(scope: rootScope)
        guard let root = roots.first(where: { $0.id == file.rootID }) else {
            return file.standardizedFullPath
        }
        return ClientPathFormatter.displayPath(
            root: root,
            relativePath: file.standardizedRelativePath,
            visibleRoots: roots
        )
    }
}

// swiftlint:enable large_tuple opening_brace statement_position
