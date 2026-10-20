// Retained source identifiers and layout; CCCC enforces the configured complexity limits.
// swiftlint:disable for_where identifier_name opening_brace
import Foundation

/// Source PathMatcher lookup helpers share the executable module, not a public API.
extension PathMatcher {
    static func findSingleComponentMatch(
        name: String,
        exactMatchOnly: Bool,
        snapshot: PathMatchSnapshot
    ) -> PathMatchLocation? {
        let threshold = exactMatchOnly ? 0.9999 : 0.9
        // NEW: roots that contain any selected file
        let rootsWithSel = rootsWithSelection(snapshot)

        // 1) Exact name matches via byFileName index (canonical)
        let key = snapshot.canonical(name)
        let exactNameMatches = snapshot.indexes.byFileName[key] ?? []

        if exactNameMatches.count == 1 {
            return makeLocation(folder: nil, file: exactNameMatches[0])
        } else if exactNameMatches.count > 1 {
            let sortedMatches = exactNameMatches.sorted { exactNamePrecedes(
                $0,
                $1,
                snapshot: snapshot,
                rootsWithSel: rootsWithSel
            ) }
            return makeLocation(folder: nil, file: sortedMatches[0])
        }

        let candidates = singleComponentCandidates(name: name, exactMatchOnly: exactMatchOnly, snapshot: snapshot)
        guard !candidates.isEmpty else { return nil }

        var passingMatches: [(score: Double, file: FileRecord)] = []
        for file in candidates {
            // Compare canonicalized names with heap-safe similarity
            // (respects case policy and folds '-'/'_' equivalence)
            let q1 = snapshot.canonical(name)
            let f1 = snapshot.canonical(file.name)
            let sim = similarityScoreMax(q1, f1, threshold: threshold, caseSensitive: snapshot.caseSensitive)

            if sim >= threshold {
                passingMatches.append((sim, file))
            }
        }
        guard !passingMatches.isEmpty else { return nil }

        if passingMatches.count == 1 {
            let bestFile = passingMatches[0].file
            return makeLocation(folder: nil, file: bestFile)
        }

        // If multiple => selected files first, then selected roots, then depth, then similarity
        passingMatches.sort { lhs, rhs in
            let lhsSelected = snapshot.selectedFileFullPaths.contains(lhs.file.fullPath)
            let rhsSelected = snapshot.selectedFileFullPaths.contains(rhs.file.fullPath)
            if lhsSelected != rhsSelected { return lhsSelected }

            let lhsRootSelected = rootsWithSel.contains(lhs.file.rootFolderPath)
            let rhsRootSelected = rootsWithSel.contains(rhs.file.rootFolderPath)
            if lhsRootSelected != rhsRootSelected { return lhsRootSelected }

            let lhsDepth = lhs.file.relativePath.split(separator: "/").count
            let rhsDepth = rhs.file.relativePath.split(separator: "/").count
            if lhsDepth == rhsDepth {
                return lhs.score > rhs.score
            }
            return lhsDepth < rhsDepth
        }
        let bestFile = passingMatches[0].file
        return makeLocation(folder: nil, file: bestFile)
    }

    // MARK: - Multi Component Match

    private static func singleComponentCandidates(name: String, exactMatchOnly: Bool,
                                                  snapshot: PathMatchSnapshot) -> [FileRecord]
    {
        // 2) Fuzzy approach bounded by indexes
        var candidates: [FileRecord] = []
        let ext = (name as NSString).pathExtension.lowercased()
        if !ext.isEmpty, let byExt = snapshot.indexes.byExtension[ext] {
            candidates.append(contentsOf: byExt)
        } else if !exactMatchOnly {
            // No extension provided: use name-bucket prefilter by first alphanumeric character and reasonable length
            // variance
            let canon = snapshot.canonical(name)
            let canonFC = firstAlnumLowercasedByte(canon)
            var added = 0
            // Iterate keys only (distinct file names), then append their groups to candidates
            for (k, group) in snapshot.indexes.byFileName {
                if let fc = canonFC {
                    guard let kfc = firstAlnumLowercasedByte(k), kfc == fc else { continue }
                }
                if abs(canon.count - k.count) > 6 { continue }
                candidates.append(contentsOf: group)
                added += group.count
                if added >= 12000 { break } // cap to avoid pathological growth
            }
        }

        return candidates
    }

    static func findBestMultiComponentMatch(
        fullPath: String,
        userComponents: [String],
        exactMatchOnly: Bool,
        snapshot: PathMatchSnapshot
    ) -> PathMatchLocation? {
        // 1) First try strict suffix matching (no fuzzy logic)
        if let strictMatch = findStrictSuffixMatch(
            userComponents: userComponents,
            snapshot: snapshot
        ) {
            return makeLocation(folder: nil, file: strictMatch)
        }

        // 2) Quick pre-check of final component using indexes
        let lastComponent = userComponents.last ?? ""
        let threshold = exactMatchOnly ? 0.9999 : 0.9

        guard lastComponentExists(in: snapshot, lastComponent: lastComponent, threshold: threshold) else {
            return nil
        }

        // 3) Attempt standard "last 3 components" fuzzy match

        if let result = fuzzyMatchWithSuffixLimit(
            fullPath: fullPath,
            userComponents: userComponents,
            suffixCount: 3,
            exactMatchOnly: exactMatchOnly,
            snapshot: snapshot
        ) {
            return result
        }

        // 4) If no match, try last 5
        if userComponents.count > 3 {
            if let result = fuzzyMatchWithSuffixLimit(
                fullPath: fullPath,
                userComponents: userComponents,
                suffixCount: 5,
                exactMatchOnly: exactMatchOnly,
                snapshot: snapshot
            ) {
                return result
            }
        }

        // 5) Fallback: entire path

        return fuzzyMatchWithSuffixLimit(
            fullPath: fullPath,
            userComponents: userComponents,
            suffixCount: userComponents.count,
            exactMatchOnly: exactMatchOnly,
            snapshot: snapshot
        )
    }

    // MARK: - Absolute path parent-qualified tail finder

    static func findStrictSuffixMatch(userComponents: [String], snapshot: PathMatchSnapshot) -> FileRecord? {
        var bestMatch: FileRecord?, bestScore = 0.0
        let candMap = strictSuffixCandidates(userComponents: userComponents, snapshot: snapshot)
        for (_, file) in candMap {
            let components = file.relativePath.split(separator: "/").map(String.init)
            guard components.count >= userComponents.count else { continue }
            let suffix = Array(components.suffix(userComponents.count))
            guard strictComponentsMatch(userComponents, suffix) else { continue }
            let score = Double(userComponents.count * 2) - Double(components.count - userComponents.count)
            if score > bestScore {
                bestScore = score; bestMatch = file
            } else if score == bestScore, let currentBest = bestMatch {
                let currentIsSelected = snapshot.selectedFileFullPaths.contains(file.fullPath)
                let bestIsSelected = snapshot.selectedFileFullPaths.contains(currentBest.fullPath)
                if currentIsSelected, !bestIsSelected { bestMatch = file }
            }
        }
        return bestMatch
    }

    private static func strictSuffixCandidates(userComponents: [String],
                                               snapshot: PathMatchSnapshot) -> [String: FileRecord]
    {
        var candMap: [String: FileRecord] = [:]
        if let last = userComponents.last {
            let key = snapshot.canonical(last)
            if let group = snapshot.indexes.byFileName[key] { for file in group {
                candMap[file.fullPath] = file
            } }
            if userComponents.count >= 2 {
                let lastTwo = userComponents[userComponents.count - 2] + "/" + userComponents[userComponents.count - 1]
                let key2 = snapshot.canonical(lastTwo)
                if let group = snapshot.indexes.byLastTwo[key2] { for file in group {
                    candMap[file.fullPath] = file
                } }
            }
        }
        return candMap
    }

    private static func strictComponentsMatch(_ user: [String], _ suffix: [String]) -> Bool {
        for (index, component) in user.enumerated() {
            if cleaned(component).lowercased() != cleaned(suffix[index]).lowercased() { return false }
        }
        return true
    }

    private static func exactNamePrecedes(_ lhs: FileRecord, _ rhs: FileRecord,
                                          snapshot: PathMatchSnapshot, rootsWithSel: Set<String>) -> Bool
    {
        let lhsSelected = snapshot.selectedFileFullPaths.contains(lhs.fullPath)
        let rhsSelected = snapshot.selectedFileFullPaths.contains(rhs.fullPath)
        if lhsSelected != rhsSelected { return lhsSelected }
        let lhsRootSelected = rootsWithSel.contains(lhs.rootFolderPath),
            rhsRootSelected = rootsWithSel.contains(rhs.rootFolderPath)
        if lhsRootSelected != rhsRootSelected { return lhsRootSelected }
        let lhsDepth = lhs.relativePath.split(separator: "/").count,
            rhsDepth = rhs.relativePath.split(separator: "/").count
        if lhsDepth != rhsDepth { return lhsDepth < rhsDepth }
        return lhs.fullPath < rhs.fullPath
    }

    static func lastComponentExists(
        in snapshot: PathMatchSnapshot,
        lastComponent: String,
        threshold _: Double
    ) -> Bool {
        let cleanedLast = cleaned(lastComponent)
        guard !cleanedLast.isEmpty else { return false }

        // O(1) checks using indexes
        let key = snapshot.canonical(cleanedLast)
        if let arr = snapshot.indexes.byFileName[key], !arr.isEmpty {
            return true
        }
        let ext = (cleanedLast as NSString).pathExtension.lowercased()
        if !ext.isEmpty, let arr = snapshot.indexes.byExtension[ext], !arr.isEmpty {
            return true
        }

        // Allow progress if indexes can't preconfirm existence
        return true
    }
}

// swiftlint:enable for_where identifier_name opening_brace
