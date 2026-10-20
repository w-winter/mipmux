import Foundation

struct PathMatchInput {
    private let query: String
    private let snapshot: PathMatchSnapshot

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: ["kind", "query", "roots"])
        query = try object.string("query")
        guard let rawRoots = object.fields["roots"] as? [Any] else { throw BridgeFailure("nativeProtocolError") }
        var files: [String: FileRecord] = [:], folders: [String: FolderRecord] = [:], roots: [FolderRecord] = []
        var rootPaths: Set<String> = []
        for raw in rawRoots {
            let root = try WireObject(raw, keys: ["name", "path", "files", "directories"])
            let name = try root.string("name"), path = try root.string("path")
            guard path.hasPrefix("/"), StandardizedPath.absolute(path) == path, rootPaths.insert(path).inserted,
                  let filePaths = root.fields["files"] as? [String],
                  let directories = root.fields["directories"] as? [String]
            else { throw BridgeFailure("nativeProtocolError") }
            roots.append(FrozenFolderRecord(name: name, relativePath: "", fullPath: path, rootPath: path))
            for relative in filePaths {
                try Self.relativePath(relative)
                let full = StandardizedPath.join(standardizedRoot: path, standardizedRelativePath: relative)
                files[full] = FrozenFileRecord(name: (relative as NSString).lastPathComponent,
                                               relativePath: relative, fullPath: full, rootFolderPath: path)
            }
            for relative in directories {
                try Self.relativePath(relative)
                let full = StandardizedPath.join(standardizedRoot: path, standardizedRelativePath: relative)
                folders[full] = FrozenFolderRecord(name: (relative as NSString).lastPathComponent,
                                                   relativePath: relative, fullPath: full, rootPath: path)
            }
        }
        let data = StaticPathMatchData(filesByFullPath: files, foldersByFullPath: folders, rootFolders: roots, id: 0)
        // mcpSelection excludes selected-file/root bias; each bridge request owns its captured indexes.
        snapshot = PathMatchSnapshot(staticData: data, selectedFileFullPaths: [],
                                     indexes: PathMatchIndexes.build(
                                         files: files,
                                         folders: folders,
                                         caseSensitive: data.caseSensitive
                                     ))
    }

    static func relativePath(_ value: String) throws {
        guard !value.isEmpty, !value.hasPrefix("/"), !value.utf8.contains(0),
              value.split(separator: "/", omittingEmptySubsequences: false)
              .allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              StandardizedPath.relative(value) == value
        else { throw BridgeFailure("nativeProtocolError") }
    }

    func render() -> [String: Any] {
        let match = PathMatcher.locate(
            userPath: query,
            options: PathLocateProfile.mcpSelection.options,
            snapshot: snapshot
        )
        let result: Any = match.map { ["rootPath": $0.rootPath, "correctedPath": $0.correctedPath] } ?? NSNull()
        return ["kind": "pathMatch", "match": result]
    }
}
