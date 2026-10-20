// Retained source identifiers and layout; CCCC enforces the configured complexity limits.
// swiftlint:disable for_where identifier_name opening_brace
import Foundation

/// Source PathMatcher lookup helpers share the executable module, not a public API.
extension PathMatcher {
    /// Bonus added to a candidate's score when its root contains at least one selected file
    static let rootSelectionBonus: Double = 0.5

    /// Common helper: compute roots that own any selected file
    static func rootsWithSelection(_ snapshot: PathMatchSnapshot) -> Set<String> {
        var set = Set<String>()
        for root in snapshot.rootFolders {
            if snapshot.selectedFileFullPaths.contains(where: { isUnder($0, root: root.fullPath) }) {
                set.insert(root.fullPath)
            }
        }
        return set
    }

    /// Root-alias matching: use canonical root.name first, then lastPathComponent as compatibility fallback.
    static func aliasRootCandidates(for component: String, snapshot: PathMatchSnapshot) -> [FolderRecord] {
        let canonicalMatches = snapshot.rootFolders.filter {
            $0.name.caseInsensitiveCompare(component) == .orderedSame
        }
        if !canonicalMatches.isEmpty {
            return canonicalMatches
        }
        return snapshot.rootFolders.filter {
            (($0.fullPath as NSString).lastPathComponent).caseInsensitiveCompare(component) == .orderedSame
        }
    }

    // Absolute-path fallback tuning
    static let absoluteSuffixFallbackEnabled = true
    static let absSuffixMinComponents = 2
    static let absSuffixMaxComponents = 20

    static func candidatesFor(
        userComponents: [String],
        snapshot: PathMatchSnapshot,
        suffixCount: Int,
        maxCap: Int = 20000
    ) -> [AnyItem] {
        let relevantComps = Array(userComponents.suffix(suffixCount))
        var fileMap: [String: FileRecord] = [:]

        func addFiles(_ arr: [FileRecord]?) {
            guard let arr, !arr.isEmpty else { return }
            for f in arr {
                if fileMap[f.fullPath] == nil {
                    fileMap[f.fullPath] = f
                    if fileMap.count >= maxCap { break }
                }
            }
        }

        if let last = relevantComps.last {
            let lastKey = snapshot.canonical(last)
            addFiles(snapshot.indexes.byFileName[lastKey])

            if relevantComps.count >= 2 {
                let lastTwo = relevantComps[relevantComps.count - 2] + "/" + relevantComps[relevantComps.count - 1]
                let lastTwoKey = snapshot.canonical(lastTwo)
                addFiles(snapshot.indexes.byLastTwo[lastTwoKey])
            }

            let ext = (last as NSString).pathExtension.lowercased()
            if !ext.isEmpty, let extGroup = snapshot.indexes.byExtension[ext] {
                if fileMap.isEmpty {
                    addFiles(extGroup)
                } else {
                    let extPaths = Set(extGroup.map(\.fullPath))
                    let filtered = fileMap.values.filter { extPaths.contains($0.fullPath) }
                    fileMap.removeAll(keepingCapacity: true)
                    for f in filtered {
                        fileMap[f.fullPath] = f
                        if fileMap.count >= maxCap { break }
                    }
                }
            }
        }

        var result: [AnyItem] = fileMap.values.map { AnyItem.file($0) }

        // Add a small set of folder candidates using previous directory component
        if relevantComps.count >= 2 {
            let prev = relevantComps[relevantComps.count - 2]
            let prevKey = snapshot.canonical(prev)
            if let folders = snapshot.indexes.foldersByLastComponent[prevKey] {
                for fo in folders {
                    result.append(.folder(fo))
                }
            }
        }

        return result
    }

    // MARK: - Helper Functions

    @inline(__always)
    static func isUnder(_ path: String, root: String) -> Bool {
        // New pure‑Swift normalization and safe boundary check
        let p2 = standardizePathFast(path)
        let r2 = standardizePathFast(root)
        if p2 == r2 { return true }
        if r2.isEmpty { return false }

        // Ensure we only match when r2 is a full directory prefix of p2
        if p2.hasPrefix(r2) {
            if p2.count == r2.count { return true }
            let idx = p2.index(p2.startIndex, offsetBy: r2.count)
            return p2[idx] == "/"
        }
        if r2.hasSuffix("/") {
            return p2.hasPrefix(r2)
        } else {
            return p2.hasPrefix(r2 + "/")
        }
    }

    @inline(__always)
    static func standardizePathFast(_ input: String) -> String {
        if input.isEmpty { return "" }
        let isAbsolute = input.hasPrefix("/")

        // Collapse separators + resolve '.' and '..' segments
        var stack = [String]()
        stack.reserveCapacity(16)

        for segSub in input.split(separator: "/", omittingEmptySubsequences: true) {
            let seg = String(segSub)
            if seg == "." { continue }
            if seg == ".." {
                if !stack.isEmpty {
                    _ = stack.popLast()
                } else if !isAbsolute {
                    // For relative paths, preserve leading '..'
                    stack.append("..")
                }
                continue
            }
            stack.append(seg)
        }

        if isAbsolute {
            // Root special case
            if stack.isEmpty { return "/" }
            return "/" + stack.joined(separator: "/")
        } else {
            return stack.joined(separator: "/")
        }
    }

    static func normalizeUserInputPath(_ path: String, snapshot: PathMatchSnapshot) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return trimmed
        }

        // If the path starts with '/', attempt to see if it's actually inside any loaded root
        if trimmed.hasPrefix("/") {
            let candidateURL = URL(fileURLWithPath: trimmed).standardizedFileURL

            // Check if the candidate path is inside any root folder
            let isUnderAnyRoot = snapshot.rootFolders.contains {
                isUnder(candidateURL.path, root: $0.fullPath)
            }

            // If it's under a root, convert to relative path
            if isUnderAnyRoot {
                for root in snapshot.rootFolders {
                    if isUnder(candidateURL.path, root: root.fullPath) {
                        let relativePath = candidateURL.path.replacingOccurrences(of: root.fullPath, with: "")
                        return relativePath.hasPrefix("/") ? String(relativePath.dropFirst()) : relativePath
                    }
                }
            }
        }

        return trimmed
    }

    static func getCandidateRoots(forFullPath fullPath: String, snapshot: PathMatchSnapshot) -> [String] {
        let fullStd = StandardizedPath.absolute(fullPath)
        let fullRes = (fullStd as NSString).resolvingSymlinksInPath
        var out = Set<String>()
        out.reserveCapacity(snapshot.rootFolders.count)
        for root in snapshot.rootFolders {
            let rStd = root.fullPath
            let rRes = (rStd as NSString).resolvingSymlinksInPath
            if isUnder(fullStd, root: rStd) || isUnder(fullRes, root: rStd) ||
                isUnder(fullStd, root: rRes) || isUnder(fullRes, root: rRes)
            {
                out.insert(rStd)
            }
        }
        return Array(out)
    }

    /// Generate candidate component lists by optionally dropping leading components
    /// until we hit a component equal to a loaded root name (case-insensitive).
    /// The first element is always the original path as typed. Subsequent elements
    /// represent head‑trimmed variants (e.g. treating a component as a root alias).
    static func buildHeadTrimVariants(
        userComponents: [String],
        firstAliasRoot: FolderRecord?,
        snapshot: PathMatchSnapshot,
        allowLeadingRootAliasTrim: Bool,
        allowHeadTrimAliases: Bool
    ) -> [([String], FolderRecord?)] {
        var variants: [([String], FolderRecord?)] = []

        // Explicit leading root aliases are consumed exactly once.
        // This makes:
        //   - "Root/file.swift"         → root-relative "file.swift"
        //   - "Root/Root/file.swift"    → root-relative "Root/file.swift"
        // and avoids silently collapsing repeated root-name prefixes.
        if allowLeadingRootAliasTrim,
           let alias = firstAliasRoot,
           userComponents.count > 1
        {
            variants.append((Array(userComponents.dropFirst()), alias))
        } else if !userComponents.isEmpty {
            variants.append((userComponents, firstAliasRoot))
        }

        // Once the first component has been claimed as an explicit root alias,
        // do not generate additional head-trim rescue variants from the original
        // path. The user can repeat the alias to address a literal same-name
        // folder under that root.
        guard allowHeadTrimAliases,
              userComponents.count > 1,
              firstAliasRoot == nil
        else {
            return variants
        }

        // Existing logic: additional head‑trimmed variants where any later
        //    component matches a root name (e.g., "apps/backend/Foo.swift"
        //    with a root named "backend").

        // Precompute canonical alias groups (case-insensitive) with compatibility fallback.
        let canonicalGroups: [String: [FolderRecord]] = Dictionary(grouping: snapshot.rootFolders) {
            $0.name.lowercased()
        }
        let lastComponentGroups: [String: [FolderRecord]] = Dictionary(grouping: snapshot.rootFolders) {
            (($0.fullPath as NSString).lastPathComponent).lowercased()
        }

        for idx in 1 ..< userComponents.count {
            let segLower = userComponents[idx].lowercased()
            let roots = canonicalGroups[segLower] ?? lastComponentGroups[segLower]
            guard let roots else { continue }

            // Drop everything up to *and including* this root-like component.
            let remainderStart = idx + 1
            guard remainderStart < userComponents.count else { continue } // nothing after root name

            let trimmed = Array(userComponents[remainderStart...])
            for root in roots {
                variants.append((trimmed, root))
            }
        }

        // Deduplicate while preserving insertion order.
        var seen = Set<String>()
        return variants.filter { comps, bias in
            let key = (bias?.fullPath ?? "all") + "|" + comps.joined(separator: "/")
            if seen.contains(key) { return false }
            seen.insert(key)
            return true
        }
    }

    static func makeLocation(folder: FolderRecord?, file: FileRecord?) -> PathMatchLocation? {
        if let f = file {
            return PathMatchLocation(
                rootPath: f.rootFolderPath,
                correctedPath: f.relativePath
            )
        }
        if let f = folder {
            return PathMatchLocation(
                rootPath: f.rootPath,
                correctedPath: f.relativePath
            )
        }
        return nil
    }

    // MARK: - Single Component Match
}

// swiftlint:enable for_where identifier_name opening_brace
