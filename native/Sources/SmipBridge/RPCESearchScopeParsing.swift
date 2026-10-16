// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

// swiftlint:disable line_length opening_brace

enum RPCESearchScopeParsing {
    struct SearchScopeParseResult {
        let spec: SearchPathFilterSpec
        let issues: [String]
        let freshnessRootRefs: [WorkspaceRootRef]
        let exactClauses: [ExactSearchScopeClause]
    }

    struct ExactSearchScopeClause {
        let clauseIndex: Int
        let rootID: UUID
        let relativePath: String
        var missingClauses: [SearchPathClause]
    }

    private enum PendingSearchScopeEntry {
        case wildcard(normalizedPath: String)
        case issue(PathResolutionIssue)
        case resolved(normalizedPath: String, lookup: WorkspacePathLookupResult)
        case lookup(normalizedPath: String)
    }

    // swiftlint:disable:next cyclomatic_complexity
    static func parseSearchScopePaths(
        _ rawPaths: [String],
        caseInsensitive: Bool,
        rootScope: WorkspaceLookupRootScope,
        store: SelectionCatalog
    ) async -> SearchScopeParseResult {
        let scopedRoots = store.rootRefs(scope: rootScope)
        var builder = SearchScopeBuilder(scopedRoots: scopedRoots)
        var pendingEntries: [PendingSearchScopeEntry] = []
        var lookupRequests: [WorkspacePathLookupRequest] = []
        for raw in rawPaths {
            let normalized = normalizeUserInputPath(raw)
            guard !normalized.isEmpty else { continue }
            let hasWildcard = normalized.contains("*") || normalized.contains("?") || normalized.contains("[")
            if hasWildcard {
                pendingEntries.append(.wildcard(normalizedPath: normalized))
                continue
            }

            if let issue = store.exactPathResolutionIssue(for: normalized, kind: .either, rootScope: rootScope) {
                pendingEntries.append(.issue(issue))
                continue
            }
            if let lookup = store.lookupDiscoverableCatalogPathForExactAbsoluteSearchScope(
                normalized,
                rootScope: rootScope
            ) {
                pendingEntries.append(.resolved(normalizedPath: normalized, lookup: lookup))
                continue
            }
            pendingEntries.append(.lookup(normalizedPath: normalized))
            lookupRequests.append(WorkspacePathLookupRequest(
                userPath: normalized,
                profile: .mcpSearchScope,
                rootScope: rootScope
            ))
        }

        let lookupResults = await store.lookupPaths(lookupRequests)
        for entry in pendingEntries {
            switch entry {
            case let .wildcard(normalizedPath):
                builder.appendWildcardClause(for: normalizedPath)
            case let .issue(issue):
                builder.appendIssue(issue)
            case let .resolved(normalizedPath, lookup):
                builder.appendLookup(lookup, normalizedPath: normalizedPath)
            case let .lookup(normalizedPath):
                if let lookup = lookupResults[normalizedPath] {
                    builder.appendLookup(lookup, normalizedPath: normalizedPath)
                } else {
                    builder.appendClause(.legacyPrefix(candidateLower: normalizedPath.lowercased()))
                }
            }
        }

        return builder.finish(caseInsensitive: caseInsensitive)
    }

    // swiftlint:disable:next function_body_length
    static func refreshExactSearchScopeClauses(
        _ parsed: SearchScopeParseResult,
        store: SelectionCatalog
    ) async -> SearchScopeParseResult {
        guard !parsed.exactClauses.isEmpty else { return parsed }
        var clauses = parsed.spec.clauses
        var disappearedExactClauses: [ExactSearchScopeClause] = []

        for exactClause in parsed.exactClauses {
            guard let lookup = store.lookupDiscoverablePath(
                rootID: exactClause.rootID,
                relativePath: exactClause.relativePath
            ) else {
                disappearedExactClauses.append(exactClause)
                continue
            }
            let restrictedRootPath = lookup.location.rootPath
            if let file = lookup.file {
                clauses[exactClause.clauseIndex] = .exactFile(
                    absPath: file.standardizedFullPath,
                    relPath: file.standardizedRelativePath,
                    restrictedRootPath: restrictedRootPath
                )
            } else if let folder = lookup.folder {
                clauses[exactClause.clauseIndex] = .exactFolder(
                    absLower: folder.standardizedFullPath.lowercased(),
                    relLower: folder.standardizedRelativePath.lowercased(),
                    restrictedRootPath: restrictedRootPath
                )
            } else {
                disappearedExactClauses.append(exactClause)
            }
        }

        if !disappearedExactClauses.isEmpty {
            let fallbacksByClauseIndex = Dictionary(
                uniqueKeysWithValues: disappearedExactClauses.map { ($0.clauseIndex, $0.missingClauses) }
            )
            var refreshedClauses: [SearchPathClause] = []
            refreshedClauses.reserveCapacity(
                clauses.count + disappearedExactClauses.reduce(0) { $0 + max(0, $1.missingClauses.count - 1) }
            )
            var seenClauseKeys = Set<String>()
            for (clauseIndex, clause) in clauses.enumerated() {
                let candidates = fallbacksByClauseIndex[clauseIndex] ?? [clause]
                for candidate in candidates
                    where seenClauseKeys.insert(String(describing: candidate)).inserted
                {
                    refreshedClauses.append(candidate)
                }
            }
            clauses = refreshedClauses
        }

        return SearchScopeParseResult(
            spec: SearchPathFilterSpec(caseInsensitive: parsed.spec.caseInsensitive, clauses: clauses),
            issues: parsed.issues,
            freshnessRootRefs: parsed.freshnessRootRefs,
            exactClauses: []
        )
    }

    private static func normalizeUserInputPath(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return trimmed }
        let expanded = (trimmed as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") {
            return StandardizedPath.absolute(expanded)
        }
        return StandardizedPath.relative(expanded)
    }
}

/// Clause deduplication, exact-path tracking and freshness requirements advance together.
private struct SearchScopeBuilder {
    private let scopedRoots: [WorkspaceRootRef]
    private var clauses: [SearchPathClause] = []
    private var issues: [String] = []
    private var exactClauses: [RPCESearchScopeParsing.ExactSearchScopeClause] = []
    private var clauseIndicesByKey: [String: Int] = [:]
    private var exactClauseIndicesByClauseIndex: [Int: Int] = [:]
    private var freshnessRootPaths = Set<String>()
    private var requiresFullFreshnessScope = false

    init(scopedRoots: [WorkspaceRootRef]) {
        self.scopedRoots = scopedRoots
    }

    @discardableResult
    mutating func appendClause(_ clause: SearchPathClause) -> Int {
        let key = String(describing: clause)
        if let existingIndex = clauseIndicesByKey[key] {
            return existingIndex
        }
        let clauseIndex = clauses.count
        clauseIndicesByKey[key] = clauseIndex
        clauses.append(clause)

        switch clause {
        case let .exactFile(_, _, restrictedRootPath),
             let .exactFolder(_, _, restrictedRootPath),
             let .glob(_, restrictedRootPath):
            if let restrictedRootPath {
                freshnessRootPaths.insert(restrictedRootPath)
            } else {
                requiresFullFreshnessScope = true
            }
        case let .legacyPrefix(candidateLower):
            if candidateLower.hasPrefix("/") {
                if let root = scopedRoots
                    .filter({ StandardizedPath.isDescendant(candidateLower, of: $0.standardizedFullPath.lowercased()) })
                    .max(by: { $0.standardizedFullPath.count < $1.standardizedFullPath.count })
                {
                    freshnessRootPaths.insert(root.standardizedFullPath)
                }
            } else {
                requiresFullFreshnessScope = true
            }
        }
        return clauseIndex
    }

    mutating func appendIssue(_ issue: PathResolutionIssue) {
        issues.append(PathResolutionIssueRenderer.message(for: issue))
        requiresFullFreshnessScope = true
    }

    mutating func appendWildcardClause(for normalized: String) {
        if normalized.hasPrefix("/"),
           let root = scopedRoots
           .filter({ normalized == $0.standardizedFullPath || normalized.hasPrefix($0.standardizedFullPath.hasSuffix("/") ? $0.standardizedFullPath : $0.standardizedFullPath + "/") })
           .max(by: { $0.standardizedFullPath.count < $1.standardizedFullPath.count })
        {
            let prefix = root.standardizedFullPath.hasSuffix("/") ? root.standardizedFullPath : root.standardizedFullPath + "/"
            let relativePattern = normalized == root.standardizedFullPath
                ? ""
                : StandardizedPath.relative(String(normalized.dropFirst(prefix.count)))
            appendClause(.glob(pattern: relativePattern, restrictedRootPath: root.standardizedFullPath))
            return
        }

        let parts = normalized.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true)
        if parts.count == 2 {
            let alias = String(parts[0])
            let matches = scopedRoots.filter { $0.name.caseInsensitiveCompare(alias) == .orderedSame }
            if matches.count == 1, let root = matches.first {
                appendClause(.glob(pattern: StandardizedPath.relative(String(parts[1])), restrictedRootPath: root.standardizedFullPath))
                return
            }
            if matches.count > 1 {
                appendIssue(.ambiguousAlias(alias: alias, matchingRoots: matches))
                return
            }
        }

        appendClause(.glob(pattern: normalized, restrictedRootPath: nil))
    }

    mutating func appendLookup(_ lookup: WorkspacePathLookupResult, normalizedPath: String) {
        let root = scopedRoots.first { $0.id == lookup.location.rootID }
        let clause: SearchPathClause
        if let file = lookup.file {
            clause = .exactFile(
                absPath: file.standardizedFullPath,
                relPath: file.standardizedRelativePath,
                restrictedRootPath: root?.standardizedFullPath
            )
        } else if let folder = lookup.folder {
            clause = .exactFolder(
                absLower: folder.standardizedFullPath.lowercased(),
                relLower: folder.standardizedRelativePath.lowercased(),
                restrictedRootPath: root?.standardizedFullPath
            )
        } else {
            return
        }
        let clauseIndex = appendClause(clause)
        let missingClause = SearchPathClause.legacyPrefix(candidateLower: normalizedPath.lowercased())
        if let exactClauseIndex = exactClauseIndicesByClauseIndex[clauseIndex] {
            guard !exactClauses[exactClauseIndex].missingClauses.contains(missingClause) else { return }
            exactClauses[exactClauseIndex].missingClauses.append(missingClause)
        } else {
            exactClauseIndicesByClauseIndex[clauseIndex] = exactClauses.count
            exactClauses.append(RPCESearchScopeParsing.ExactSearchScopeClause(
                clauseIndex: clauseIndex,
                rootID: lookup.location.rootID,
                relativePath: lookup.location.correctedPath,
                missingClauses: [missingClause]
            ))
        }
    }

    func finish(caseInsensitive: Bool) -> RPCESearchScopeParsing.SearchScopeParseResult {
        let freshnessRootRefs = if requiresFullFreshnessScope || clauses.isEmpty {
            scopedRoots
        } else {
            scopedRoots.filter { freshnessRootPaths.contains($0.standardizedFullPath) }
        }
        return RPCESearchScopeParsing.SearchScopeParseResult(
            spec: SearchPathFilterSpec(caseInsensitive: caseInsensitive, clauses: clauses),
            issues: issues,
            freshnessRootRefs: freshnessRootRefs,
            exactClauses: exactClauses
        )
    }
}

// swiftlint:enable line_length opening_brace
