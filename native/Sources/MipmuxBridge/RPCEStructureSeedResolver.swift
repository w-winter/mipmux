// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Immutable catalog lookups replace app scope/metadata/ingress dependencies.
import Foundation

enum RPCEStructureSeedResolver {
    private static let maximumCodeStructureSeedCount = 8192

    struct RootSeeds {
        let root: StructureInput.Root
        let seeds: [UUID]
    }

    static func resolve(_ input: StructureInput.SeedInput, roots: [StructureInput.Root]) throws -> [RootSeeds] {
        let catalog = StructureSeedCatalog(roots: roots)
        let files = try input.kind == .paths
            ? resolveFilesForCodeStructure(
                input.selectors,
                catalog: catalog,
                maximumSeedCount: maximumCodeStructureSeedCount
            )
            : resolveSelectedFilesForCodeStructure(
                input.selectors,
                catalog: catalog,
                maximumSeedCount: maximumCodeStructureSeedCount
            )
        let byRoot = Dictionary(grouping: files, by: \.rootID)
        return roots.map { RootSeeds(root: $0, seeds: (byRoot[$0.id] ?? []).map(\.fileID)) }
    }

    private static func resolveSelectedFilesForCodeStructure(
        _ selectors: [StructureInput.Selector],
        catalog: StructureSeedCatalog,
        maximumSeedCount: Int
    ) throws -> [StructureSeedCatalog.File] {
        precondition(maximumSeedCount > 0)
        var files: [StructureSeedCatalog.File] = []
        var seenStandardizedFullPaths = Set<String>()
        for selector in selectors {
            try Task.checkCancellation()
            if let file = catalog.lookupFile(selector) {
                guard seenStandardizedFullPaths.insert(file.standardizedFullPath).inserted else { continue }
                files.append(file)
                if files.count > maximumSeedCount { return files }
                continue
            }
            let folderResolution = catalog.expandFolderInputToFiles(
                selector,
                excludingStandardizedFullPaths: seenStandardizedFullPaths,
                maximumUniqueFileCount: maximumSeedCount - files.count
            )
            guard folderResolution.handled else { continue }
            for file in folderResolution.files
                where seenStandardizedFullPaths.insert(file.standardizedFullPath).inserted {
                files.append(file)
            }
            if folderResolution.didExceedLimit { return files }
        }
        return files
    }

    private static func resolveFilesForCodeStructure(
        _ paths: [StructureInput.Selector],
        catalog: StructureSeedCatalog,
        maximumSeedCount: Int
    ) throws -> [StructureSeedCatalog.File] {
        precondition(maximumSeedCount > 0)
        try Task.checkCancellation()
        let directFiles = Dictionary(uniqueKeysWithValues: Set(paths).compactMap { selector in
            catalog.lookupFile(selector).map { (selector, $0) }
        })
        let matchedFileInputs = Set(directFiles.keys)
        var resolved: [StructureSeedCatalog.File] = []
        var seenStandardizedFullPaths = Set<String>()
        for path in paths {
            try Task.checkCancellation()
            guard let file = directFiles[path], seenStandardizedFullPaths.insert(file.standardizedFullPath).inserted
            else { continue }
            resolved.append(file)
            if resolved.count > maximumSeedCount { return resolved }
        }
        let dirCandidates = paths.filter { !matchedFileInputs.contains($0) }
        for raw in dirCandidates {
            try Task.checkCancellation()
            let folderResolution = catalog.expandFolderInputToFiles(
                raw,
                excludingStandardizedFullPaths: seenStandardizedFullPaths,
                maximumUniqueFileCount: maximumSeedCount - resolved.count
            )
            try Task.checkCancellation()
            guard folderResolution.handled else { continue }
            for file in folderResolution.files
                where seenStandardizedFullPaths.insert(file.standardizedFullPath).inserted {
                resolved.append(file)
            }
            if folderResolution.didExceedLimit { return resolved }
        }
        return resolved
    }
}
