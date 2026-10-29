import Foundation

/// One captured catalog owns physical-path deduplication and ordered folder/file adjacency.
final class StructureSeedCatalog {
    struct File {
        let fileID: UUID
        let rootID: UUID
        let standardizedFullPath: String
    }

    struct Folder {
        let id: UUID
        let rootID: UUID
    }

    struct RootState {
        var childFileIDsByFolderID: [UUID: [UUID]] = [:]
        var childFolderIDsByFolderID: [UUID: [UUID]] = [:]
    }

    struct Expansion {
        let files: [File]
        let handled: Bool
        let didExceedLimit: Bool
    }

    private(set) var filesByID: [UUID: File] = [:]
    private(set) var foldersByID: [UUID: Folder] = [:]
    private(set) var rootStatesByID: [UUID: RootState] = [:]
    private var filesByPath: [Data: File] = [:]
    private var foldersByPath: [Data: Folder] = [:]

    init(roots: [StructureInput.Root]) {
        for root in roots {
            rootStatesByID[root.id] = RootState()
            for path in [""] + root.directories {
                _ = folder(root: root, path: path)
            }
            for input in root.files {
                let parentPath = relativeParent(input.path)
                let parent = folder(root: root, path: parentPath)
                let file = File(
                    fileID: input.id,
                    rootID: root.id,
                    standardizedFullPath: (root.canonicalPath as NSString)
                        .appendingPathComponent(input.path)
                )
                filesByID[file.fileID] = file
                filesByPath[Self.key(root: root.name, path: input.path)] = file
                rootStatesByID[root.id]!.childFileIDsByFolderID[parent.id, default: []].append(file.fileID)
            }
        }
    }

    private static func key(root: String, path: String) -> Data {
        Data((root + "\0" + path).utf8)
    }

    private func folder(root: StructureInput.Root, path: String) -> Folder {
        let key = Self.key(root: root.name, path: path)
        if let known = foldersByPath[key] { return known }
        let value = Folder(id: UUID(), rootID: root.id)
        foldersByPath[key] = value
        foldersByID[value.id] = value
        if !path.isEmpty {
            let parent = folder(root: root, path: relativeParent(path))
            rootStatesByID[root.id]!.childFolderIDsByFolderID[parent.id, default: []].append(value.id)
        }
        return value
    }

    func lookupFile(_ selector: StructureInput.Selector) -> File? {
        selector.kind == .file ? filesByPath[Self.key(root: selector.root, path: selector.path)] : nil
    }

    func expandFolderInputToFiles(
        _ selector: StructureInput.Selector,
        excludingStandardizedFullPaths: Set<String>,
        maximumUniqueFileCount: Int
    ) -> Expansion {
        precondition(maximumUniqueFileCount >= 0)
        guard selector.kind == .directory,
              let folder = foldersByPath[Self.key(root: selector.root, path: selector.path)]
        else { return Expansion(files: [], handled: false, didExceedLimit: false) }
        let result = boundedDescendantFiles(
            in: folder.id,
            excludingStandardizedFullPaths: excludingStandardizedFullPaths,
            maximumUniqueFileCount: maximumUniqueFileCount
        )
        return Expansion(files: result.files, handled: true, didExceedLimit: result.didExceedLimit)
    }

    private func isDiscoverableFileID(_ id: UUID) -> Bool {
        filesByID[id] != nil
    }

    private func isDiscoverableFolderID(_ id: UUID) -> Bool {
        foldersByID[id] != nil
    }

    private func boundedDescendantFiles(
        in folderID: UUID,
        excludingStandardizedFullPaths: Set<String>,
        maximumUniqueFileCount: Int
    ) -> (files: [File], didExceedLimit: Bool) {
        guard let folder = foldersByID[folderID],
              let state = rootStatesByID[folder.rootID]
        else { return ([], false) }

        var files: [File] = []
        var seenStandardizedFullPaths = excludingStandardizedFullPaths
        var visitedFolderIDs = Set<UUID>()

        func visit(_ currentFolderID: UUID) -> Bool {
            guard visitedFolderIDs.insert(currentFolderID).inserted else { return false }

            for fileID in state.childFileIDsByFolderID[currentFolderID] ?? [] {
                guard isDiscoverableFileID(fileID),
                      let file = filesByID[fileID],
                      seenStandardizedFullPaths.insert(file.standardizedFullPath).inserted
                else { continue }
                files.append(file)
                if files.count > maximumUniqueFileCount { return true }
            }
            for childFolderID in state.childFolderIDsByFolderID[currentFolderID] ?? [] {
                guard isDiscoverableFolderID(childFolderID) else { continue }
                if visit(childFolderID) { return true }
            }
            return false
        }

        let didExceedLimit = visit(folderID)
        return (files, didExceedLimit)
    }
}
