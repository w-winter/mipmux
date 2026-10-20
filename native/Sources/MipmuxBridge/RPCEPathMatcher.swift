// Retained source identifiers and layout; CCCC enforces the configured complexity limits.
// swiftlint:disable opening_brace
import Foundation

enum PathMatcher {
    static func locate(userPath: String, options: PathLocateOptions,
                       snapshot: PathMatchSnapshot) -> PathMatchLocation?
    {
        let raw = PathCharPolicy.foldHomoglyphsIfNeeded(userPath.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !raw.isEmpty else { return nil }
        let trimmedPath = raw.hasPrefix("/") ? raw : normalizeUserInputPath(raw, snapshot: snapshot)
        let standardizedPath = StandardizedPath.absolute(trimmedPath)
        guard !standardizedPath.isEmpty else { return nil }
        let userComponents = standardizedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .split(separator: "/").map(String.init)
        if standardizedPath.hasPrefix("/") {
            return locateAbsolute(standardizedPath: standardizedPath, userComponents: userComponents,
                                  options: options, snapshot: snapshot)
        }
        return locateRelative(standardizedPath: standardizedPath, userComponents: userComponents,
                              options: options, snapshot: snapshot)
    }

    private static func locateAbsolute(standardizedPath: String, userComponents: [String],
                                       options: PathLocateOptions, snapshot: PathMatchSnapshot) -> PathMatchLocation?
    {
        if let directFullMatch = snapshot.file(standardizedPath) {
            return PathMatchLocation(
                rootPath: directFullMatch.rootFolderPath,
                correctedPath: directFullMatch.relativePath
            )
        }
        var candidateRoots = getCandidateRoots(forFullPath: standardizedPath, snapshot: snapshot)
        if candidateRoots.isEmpty {
            let resolvedFull = (standardizedPath as NSString).resolvingSymlinksInPath
            candidateRoots = getCandidateRoots(forFullPath: resolvedFull, snapshot: snapshot)
        }
        if candidateRoots.isEmpty {
            if !options.exactMatchOnly, options.allowAbsoluteSuffixFallback, absoluteSuffixFallbackEnabled,
               let hit = findAbsoluteParentQualifiedTail(
                   userComponents: userComponents,
                   minTail: absSuffixMinComponents,
                   maxTail: min(absSuffixMaxComponents, userComponents.count),
                   snapshot: snapshot
               ) { return hit }
            return nil
        }
        if let parent = absoluteParentMatch(
            userComponents: userComponents,
            candidateRoots: candidateRoots,
            snapshot: snapshot
        ) {
            return parent
        }
        if options.exactMatchOnly { return nil }
        let match: PathMatchLocation? = if userComponents.count == 1 {
            findSingleComponentMatch(
                name: userComponents[0],
                exactMatchOnly: options.exactMatchOnly,
                snapshot: snapshot
            )
        } else {
            findBestMultiComponentMatch(fullPath: standardizedPath, userComponents: userComponents,
                                        exactMatchOnly: options.exactMatchOnly, snapshot: snapshot)
        }
        guard let match else { return nil }
        guard candidateRoots.contains(match.rootPath) else { return nil }
        return match
    }

    private static func absoluteParentMatch(userComponents: [String], candidateRoots: [String],
                                            snapshot: PathMatchSnapshot) -> PathMatchLocation?
    {
        guard userComponents.count > 1, !candidateRoots.isEmpty else { return nil }
        let fileName = userComponents.last!
        let parentRel = userComponents.dropLast().joined(separator: "/")
        let standardizedParentRel = StandardizedPath.relative(parentRel)
        for rootPath in candidateRoots {
            let folderAbs = standardizedLookupPath(rootPath: rootPath, relativePath: standardizedParentRel)
            if snapshot.folderRecord(forStandardizedFullPath: folderAbs) != nil {
                let expectedFilePath = appendStandardizedRelativePath(rootPath: folderAbs, relativePath: fileName)
                if let file = snapshot.fileRecord(forStandardizedFullPath: expectedFilePath) {
                    return PathMatchLocation(rootPath: file.rootFolderPath, correctedPath: file.relativePath)
                }
            }
        }
        return nil
    }

    private static func locateRelative(standardizedPath: String, userComponents: [String],
                                       options: PathLocateOptions, snapshot: PathMatchSnapshot) -> PathMatchLocation?
    {
        let aliasRoot: FolderRecord? = {
            guard let first = userComponents.first else { return nil }
            return aliasRootCandidates(for: first, snapshot: snapshot).first
        }()
        let relForMatch = aliasRoot != nil && userComponents.count > 1
            ? userComponents.dropFirst().joined(separator: "/") : standardizedPath
        let compsForMatch = aliasRoot != nil && userComponents.count > 1
            ? Array(userComponents.dropFirst()) : userComponents
        let rootsWithSel = rootsWithSelection(snapshot)
        let variants = buildHeadTrimVariants(
            userComponents: userComponents,
            firstAliasRoot: aliasRoot,
            snapshot: snapshot,
            allowLeadingRootAliasTrim: options.allowLeadingRootAliasTrim,
            allowHeadTrimAliases: options.allowHeadTrimAliases
        )
        if let match = strictVariantMatch(
            variants: variants,
            aliasRoot: aliasRoot,
            rootsWithSel: rootsWithSel,
            snapshot: snapshot
        ) {
            return match
        }
        if let match = parentVariantMatch(variants: variants, snapshot: snapshot) { return match }
        if options.exactMatchOnly { return nil }
        if aliasRoot != nil, options.allowLeadingRootAliasTrim { return nil }
        if compsForMatch.count == 1 {
            return findSingleComponentMatch(
                name: compsForMatch[0],
                exactMatchOnly: options.exactMatchOnly,
                snapshot: snapshot
            )
        }
        if let match = findBestMultiComponentMatch(fullPath: relForMatch, userComponents: compsForMatch,
                                                   exactMatchOnly: options.exactMatchOnly, snapshot: snapshot)
        {
            return match
        }
        if let hit = findBestMatchWithOneMissingComponent(userComponents: compsForMatch,
                                                          exactMatchOnly: options.exactMatchOnly, snapshot: snapshot)
        {
            return PathMatchLocation(rootPath: hit.rootFolderPath, correctedPath: hit.relativePath)
        }
        return nil
    }

    private static func strictVariantMatch(variants: [([String], FolderRecord?)], aliasRoot: FolderRecord?,
                                           rootsWithSel: Set<String>,
                                           snapshot: PathMatchSnapshot) -> PathMatchLocation?
    {
        for (variantComps, biasRoot) in variants {
            guard !variantComps.isEmpty else { continue }
            let relative = StandardizedPath.relative(variantComps.joined(separator: "/"))
            if let biasRoot {
                let absolute = standardizedLookupPath(rootPath: biasRoot.fullPath, relativePath: relative)
                if let hit = snapshot.fileRecord(forStandardizedFullPath: absolute) {
                    return PathMatchLocation(rootPath: hit.rootFolderPath, correctedPath: hit.relativePath)
                }
            } else {
                let ordered = snapshot.rootFolders.sorted { strictRootPrecedes(
                    $0,
                    $1,
                    selected: rootsWithSel,
                    alias: aliasRoot
                ) }
                for root in ordered {
                    let absolute = standardizedLookupPath(rootPath: root.fullPath, relativePath: relative)
                    if let hit = snapshot.fileRecord(forStandardizedFullPath: absolute) {
                        return PathMatchLocation(rootPath: hit.rootFolderPath, correctedPath: hit.relativePath)
                    }
                }
            }
        }
        return nil
    }

    private static func strictRootPrecedes(_ lhs: FolderRecord, _ rhs: FolderRecord,
                                           selected: Set<String>, alias: FolderRecord?) -> Bool
    {
        let lhsSel = selected.contains(lhs.fullPath), rhsSel = selected.contains(rhs.fullPath)
        if lhsSel != rhsSel { return lhsSel }
        if let alias {
            let lhsAlias = lhs.fullPath == alias.fullPath, rhsAlias = rhs.fullPath == alias.fullPath
            if lhsAlias != rhsAlias { return lhsAlias }
        }
        return lhs.fullPath < rhs.fullPath
    }

    private static func parentVariantMatch(variants: [([String], FolderRecord?)],
                                           snapshot: PathMatchSnapshot) -> PathMatchLocation?
    {
        for (variantComps, biasRoot) in variants {
            guard variantComps.count > 1 else { continue }
            let fileName = variantComps.last!
            let folderRel = StandardizedPath.relative(variantComps.dropLast().joined(separator: "/"))
            let orderedRoots: [FolderRecord] = {
                if let biasRoot { return [biasRoot] + snapshot.rootFolders.filter { $0.fullPath != biasRoot.fullPath } }
                return snapshot.rootFolders
            }()
            for root in orderedRoots {
                let folderAbs = standardizedLookupPath(rootPath: root.fullPath, relativePath: folderRel)
                if snapshot.folderRecord(forStandardizedFullPath: folderAbs) != nil {
                    let expected = appendStandardizedRelativePath(rootPath: folderAbs, relativePath: fileName)
                    if let file = snapshot.fileRecord(forStandardizedFullPath: expected) {
                        return PathMatchLocation(rootPath: file.rootFolderPath, correctedPath: file.relativePath)
                    }
                }
            }
        }
        return nil
    }
}

// swiftlint:enable opening_brace
