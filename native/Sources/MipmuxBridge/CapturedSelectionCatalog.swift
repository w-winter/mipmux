import Foundation

/// Builds parent-linked captured records once; no filesystem lookup or catalog mutation occurs here.
struct CapturedSelectionCatalog {
    var roots: [WorkspaceRootRef] = []
    var files: [WorkspaceFileRecord] = []
    var folders: [WorkspaceFolderRecord] = []
    var discoverableFiles: Set<UUID> = []
    var discoverableFolders: Set<UUID> = []

    init(_ values: [Any]) throws {
        var rootIDs: Set<UUID> = [], rootPaths: Set<String> = []
        for value in values {
            let object = try WireObject(value, keys: ["id", "name", "path", "files", "directories"])
            let path = try object.string("path"), name = try object.string("name")
            guard let id = try UUID(uuidString: object.string("id")), rootIDs.insert(id).inserted,
                  path.hasPrefix("/"), StandardizedPath.absolute(path) == path, rootPaths.insert(path).inserted,
                  let fileValues = object.fields["files"] as? [Any],
                  let directoryValues = object.fields["directories"] as? [Any]
            else { throw BridgeFailure("nativeProtocolError") }
            roots.append(WorkspaceRootRef(id: id, name: name, fullPath: path))
            let rootFolder = WorkspaceFolderRecord(
                rootID: id,
                name: name,
                relativePath: "",
                fullPath: path,
                parentFolderID: nil
            )
            folders.append(rootFolder)
            discoverableFolders.insert(rootFolder.id)
            let directories = try Self.members(directoryValues)
            var folderIDs = Dictionary(uniqueKeysWithValues: directories.map { ($0.path, UUID()) })
            folderIDs[""] = rootFolder.id
            for directory in directories {
                let parent = Self.parent(directory.path)
                guard let parentID = folderIDs[parent] else { throw BridgeFailure("nativeProtocolError") }
                let full = StandardizedPath.join(standardizedRoot: path, standardizedRelativePath: directory.path)
                let folder = WorkspaceFolderRecord(id: folderIDs[directory.path]!, rootID: id,
                                                   name: (directory.path as NSString).lastPathComponent,
                                                   relativePath: directory.path,
                                                   fullPath: full, parentFolderID: parentID)
                folders.append(folder)
                if directory.discoverable { discoverableFolders.insert(folder.id) }
            }
            for file in try Self.members(fileValues) {
                guard folderIDs[file.path] == nil, let parentID = folderIDs[Self.parent(file.path)]
                else { throw BridgeFailure("nativeProtocolError") }
                let record = WorkspaceFileRecord(rootID: id, name: (file.path as NSString).lastPathComponent,
                                                 relativePath: file.path,
                                                 fullPath: StandardizedPath.join(
                                                     standardizedRoot: path,
                                                     standardizedRelativePath: file.path
                                                 ),
                                                 parentFolderID: parentID)
                files.append(record)
                if file.discoverable { discoverableFiles.insert(record.id) }
            }
        }
    }

    private static func parent(_ path: String) -> String {
        path.split(separator: "/").dropLast().joined(separator: "/")
    }

    private static func members(_ values: [Any]) throws -> [(path: String, discoverable: Bool)] {
        var seen: Set<String> = []
        return try values.map { raw in
            let object = try WireObject(raw, keys: ["path", "discoverable"])
            let path = try object.string("path")
            try PathMatchInput.relativePath(path)
            guard seen.insert(path).inserted else { throw BridgeFailure("nativeProtocolError") }
            return try (path, object.boolean("discoverable"))
        }
    }
}
