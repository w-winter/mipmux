// Retained source identifiers and layout; CCCC enforces the configured complexity limits.
// swiftlint:disable for_where identifier_name opening_brace optional_data_string_conversion
import Foundation

/// Source PathMatcher lookup helpers share the executable module, not a public API.
extension PathMatcher {
    static func findAbsoluteParentQualifiedTail(
        userComponents: [String],
        minTail: Int,
        maxTail: Int,
        snapshot: PathMatchSnapshot
    ) -> PathMatchLocation? {
        guard userComponents.count >= minTail else { return nil }
        let rootsWithSel = rootsWithSelection(snapshot)

        struct Cand { let file: FileRecord }
        var candidates: [Cand] = []

        let minN = max(2, minTail)
        let maxN = max(minN, maxTail)

        candidates = qualifyingTailFiles(userComponents: userComponents, minN: minN, maxN: maxN, snapshot: snapshot)
            .map { Cand(file: $0) }

        if candidates.isEmpty {
            // Fallback: match by last two components across all files.
            if userComponents.count >= 2 {
                let lowerSuffix = userComponents.suffix(2).joined(separator: "/").lowercased()
                for (_, file) in snapshot.filesByFullPath {
                    if file.relativePath.lowercased().hasSuffix(lowerSuffix) {
                        candidates.append(Cand(file: file))
                    }
                }
            }
        }
        guard !candidates.isEmpty else { return nil }

        // Tie-breakers: selected roots, shallower depth, lexicographic fullPath
        candidates.sort { lhs, rhs in
            let lSel = rootsWithSel.contains(lhs.file.rootFolderPath)
            let rSel = rootsWithSel.contains(rhs.file.rootFolderPath)
            if lSel != rSel { return lSel }
            let lDepth = lhs.file.relativePath.split(separator: "/").count
            let rDepth = rhs.file.relativePath.split(separator: "/").count
            if lDepth != rDepth { return lDepth < rDepth }
            return lhs.file.fullPath < rhs.file.fullPath
        }
        let best = candidates[0].file
        return PathMatchLocation(rootPath: best.rootFolderPath, correctedPath: best.relativePath)
    }

    private static func qualifyingTailFiles(userComponents: [String], minN: Int, maxN: Int,
                                            snapshot: PathMatchSnapshot) -> [FileRecord]
    {
        var candidates: [FileRecord] = []
        for n in minN ... min(maxN, userComponents.count) {
            // parent = last (n-1), filename = last
            let parentRel = userComponents.suffix(n).dropLast().joined(separator: "/")
            let fileName = userComponents.last ?? ""
            if parentRel.isEmpty || fileName.isEmpty { continue }

            let standardizedParentRel = StandardizedPath.relative(parentRel)
            for root in snapshot.rootFolders {
                let folderAbs = standardizedLookupPath(rootPath: root.fullPath, relativePath: standardizedParentRel)
                if snapshot.folderRecord(forStandardizedFullPath: folderAbs) != nil {
                    let fileAbs = appendStandardizedRelativePath(rootPath: folderAbs, relativePath: fileName)
                    if let fileVM = snapshot.fileRecord(forStandardizedFullPath: fileAbs) {
                        candidates.append(fileVM)
                    }
                }
            }
            if !candidates.isEmpty { break } // prefer the shortest qualifying tail
        }

        return candidates
    }

    // MARK: - Helper Functions

    @inline(__always)
    static func cleaned(_ str: String) -> String {
        // Quick ASCII probe: if all bytes < 0x80, skip folding entirely
        var isASCII = true
        for b in str.utf8 {
            if b >= 0x80 { isASCII = false
                break
            }
        }
        let input = isASCII ? str : PathCharPolicy.foldHomoglyphsIfNeeded(str)
        // Fast ASCII-only filter
        var sawNonASCII = false
        var out = [UInt8]()
        out.reserveCapacity(input.utf8.count)
        for b in input.utf8 {
            if b < 0x80 {
                if PathCharPolicy.isAllowedASCIIByte(b) { out.append(b) }
            } else {
                sawNonASCII = true
            }
        }
        if !sawNonASCII {
            return String(decoding: out, as: UTF8.self)
        }

        // Slow Unicode fallback: preserve alphanumerics
        var scalars = String.UnicodeScalarView()
        scalars.reserveCapacity(input.unicodeScalars.count)
        for sc in input.unicodeScalars {
            // After pre-folding, just keep allowed ASCII and all alphanumerics
            if sc.value < 0x80 {
                if PathCharPolicy.isAllowedASCIIByte(UInt8(truncatingIfNeeded: sc.value)) {
                    scalars.append(sc)
                }
            } else if CharacterSet.alphanumerics.contains(sc) {
                scalars.append(sc)
            }
        }
        return String(scalars)
    }

    static func fuzzyMatchWithSuffixLimit(
        fullPath _: String,
        userComponents: [String],
        suffixCount: Int,
        exactMatchOnly: Bool,
        snapshot: PathMatchSnapshot
    ) -> PathMatchLocation? {
        let threshold = exactMatchOnly ? 0.9999 : 0.9
        let relevantComps = Array(userComponents.suffix(suffixCount))
        let relevantCompsClean = relevantComps.map { cleaned($0) }

        // Index-driven candidates
        let candidates = candidatesFor(
            userComponents: userComponents,
            snapshot: snapshot,
            suffixCount: suffixCount
        )
        let rootsWithSel = rootsWithSelection(snapshot)

        var bestScore = -Double.infinity
        var bestItem: (folder: FolderRecord?, file: FileRecord?)?

        for item in candidates {
            guard let rawScore = computeWeightedMatchScorePrecleaned(
                item: item,
                userComponentsClean: relevantCompsClean,
                threshold: threshold
            ) else { continue }
            // Apply root-selection bonus
            let adjustedScore: Double = switch item {
            case let .file(f): rawScore + (rootsWithSel.contains(f.rootFolderPath) ? rootSelectionBonus : 0.0)
            case let .folder(f): rawScore + (rootsWithSel.contains(f.rootPath) ? rootSelectionBonus : 0.0)
            }

            if adjustedScore > bestScore {
                bestScore = adjustedScore
                switch item {
                case let .folder(f): bestItem = (f, nil)
                case let .file(f): bestItem = (nil, f)
                }

            } else if adjustedScore == bestScore, bestItem != nil,
                      prefersSelectedFile(item, over: bestItem, snapshot: snapshot)
            {
                if case let .file(file) = item { bestItem = (nil, file) }
            }
        }

        guard let (foundFolder, foundFile) = bestItem else {
            return nil
        }

        return makeLocation(folder: foundFolder, file: foundFile)
    }

    private static func prefersSelectedFile(_ item: AnyItem, over existing: (folder: FolderRecord?, file: FileRecord?)?,
                                            snapshot: PathMatchSnapshot) -> Bool
    {
        guard case let .file(current) = item, let existingFile = existing?.file else { return false }
        let currentIsSelected = snapshot.selectedFileFullPaths.contains(current.fullPath)
        let existingIsSelected = snapshot.selectedFileFullPaths.contains(existingFile.fullPath)
        return currentIsSelected && !existingIsSelected
    }

    /// Variant that expects user components already cleaned (reduces per-candidate work).
    static func computeWeightedMatchScorePrecleaned(
        item: AnyItem,
        userComponentsClean: [String],
        threshold: Double
    ) -> Double? {
        let pathComponents = item.relativePath.split(separator: "/")

        // Require at least as many path components as user components
        guard pathComponents.count >= userComponentsClean.count else { return nil }

        var totalScore = 0.0
        var matchedCount = 0

        // Match from right to left (suffix first)
        for i in 0 ..< userComponentsClean.count {
            let userIndex = userComponentsClean.count - 1 - i
            let pathIndex = pathComponents.count - 1 - i

            let userComp = userComponentsClean[userIndex]
            let pathComp = cleaned(String(pathComponents[pathIndex]))

            // Early exit: compare first *alphanumeric* char (ignores leading '_' / '-')
            if let uf = firstAlnumLowercasedByte(userComp),
               let pf = firstAlnumLowercasedByte(pathComp),
               uf != pf
            {
                return nil
            }

            // Early exit: check length difference
            if abs(userComp.count - pathComp.count) > 6 {
                return nil
            }

            // For the last component (file name), use stricter threshold
            let componentThreshold = (i == 0) ? threshold + 0.05 : threshold

            // Heap-safe similarity with separator folding
            let sim = similarityScoreMax(
                userComp,
                pathComp,
                threshold: componentThreshold,
                caseSensitive: false // userComponentsClean are already cleaned/canonicalized
            )

            if sim < componentThreshold {
                return nil
            }

            // Weight: 2 for filename, 1 for directories
            let weight = (i == 0) ? 2.0 : 1.0
            totalScore += sim * weight
            matchedCount += 1
        }

        // Depth penalty: -1 for each extra directory
        let depthPenalty = Double(pathComponents.count - userComponentsClean.count)

        // Match count bonus: +0.1 for each matched component
        let matchBonus = Double(matchedCount) * 0.1

        return totalScore - depthPenalty + matchBonus
    }

    /// Legacy wrapper kept for call-sites that haven’t been updated (e.g., missing-component fallback).
    @inline(__always)
    static func computeWeightedMatchScore(
        item: AnyItem,
        userComponents: [String],
        threshold: Double
    ) -> Double? {
        computeWeightedMatchScorePrecleaned(
            item: item,
            userComponentsClean: userComponents.map { cleaned($0) },
            threshold: threshold
        )
    }

    // MARK: - Missing Component Tolerance

    static func findBestMatchWithOneMissingComponent(
        userComponents: [String],
        exactMatchOnly: Bool,
        snapshot: PathMatchSnapshot
    ) -> FileRecord? {
        guard userComponents.count >= 2 else { return nil }

        let threshold = exactMatchOnly ? 0.9999 : 0.85
        var bestMatch: FileRecord?
        var bestScore = -Double.infinity

        // Try removing one component at a time
        for skipIndex in 0 ..< userComponents.count {
            var adjustedComponents = userComponents
            adjustedComponents.remove(at: skipIndex)

            let allItems = gatherAllFolderAndFileItems(snapshot: snapshot)

            for item in allItems {
                guard case let .file(file) = item else { continue }

                if let score = computeWeightedMatchScore(
                    item: .file(file),
                    userComponents: adjustedComponents,
                    threshold: threshold
                ) {
                    // Apply stronger penalty for missing component
                    let penalizedScore = score - 1.25

                    // When scores are equal, prefer shallower paths
                    let currentDepth = file.relativePath.split(separator: "/").count
                    let bestDepth = bestMatch?.relativePath.split(separator: "/").count ?? Int.max

                    if penalizedScore > bestScore || (penalizedScore == bestScore && currentDepth < bestDepth) {
                        bestScore = penalizedScore
                        bestMatch = file
                    }
                }
            }
        }

        return bestMatch
    }

    // MARK: - Item Gathering

    static func gatherAllFolderAndFileItems(snapshot: PathMatchSnapshot) -> [AnyItem] {
        var result = [AnyItem]()

        // Add all files from the filesByFullPath dictionary
        for (_, file) in snapshot.filesByFullPath {
            result.append(.file(file))
        }

        // Add all folders from the foldersByFullPath dictionary
        for (_, folder) in snapshot.foldersByFullPath {
            result.append(.folder(folder))
        }

        return result
    }
}

// swiftlint:enable for_where identifier_name opening_brace optional_data_string_conversion
