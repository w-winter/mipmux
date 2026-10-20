import Foundation

private final class TreeFolder {
    let id = UUID()
    let name: String
    let fullPath: String
    let rootPath: String
    var folders: [Data: TreeFolder] = [:]
    var files: [FileTreeFileSnapshot] = []

    init(name: String, fullPath: String, rootPath: String) {
        self.name = name
        self.fullPath = fullPath
        self.rootPath = rootPath
    }

    func snapshot() -> FileTreeFolderSnapshot {
        let orderedFolders = folders.values.sorted { $0.name.utf8.lexicographicallyPrecedes($1.name.utf8) }
        return FileTreeFolderSnapshot(
            id: id, name: name, fullPath: fullPath, standardizedFullPath: fullPath, standardizedRootPath: rootPath,
            children: orderedFolders.map { .folder($0.snapshot()) } + files.map { .file($0) }
        )
    }
}

struct FileTreeInput {
    private let roots: [TreeFolder]
    private let selectedIDs: Set<UUID>
    private let mode: String
    private let depth: Int?
    private let includeLegend: Bool
    private let showFullPaths: Bool
    private let onlyIncludeRootsWithSelectedFiles: Bool
    private let showCodeMapMarkers: Bool

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: [
            "kind", "roots", "entries", "scope", "mode", "maxDepth", "includeLegend", "showFullPaths",
            "onlyIncludeRootsWithSelectedFiles", "showCodeMapMarkers"
        ])
        guard let rawRoots = object.fields["roots"] as? [Any], let entries = object.fields["entries"] as? [Any]
        else { throw BridgeFailure("nativeProtocolError") }
        mode = try object.string("mode")
        guard ["auto", "full", "folders", "selected"].contains(mode) else { throw BridgeFailure("nativeProtocolError") }
        depth = object.fields["maxDepth"] is NSNull ? nil : try object.integer("maxDepth")
        includeLegend = try object.boolean("includeLegend")
        showFullPaths = try object.boolean("showFullPaths")
        onlyIncludeRootsWithSelectedFiles = try object.boolean("onlyIncludeRootsWithSelectedFiles")
        showCodeMapMarkers = try object.boolean("showCodeMapMarkers")
        let parsedRoots = try Self.parseRoots(rawRoots)
        selectedIDs = try Self.populateEntries(entries, roots: parsedRoots.byName)
        roots = try Self.scopedRoots(object.value("scope"), roots: parsedRoots.byName, order: parsedRoots.order)
    }

    private static func parseRoots(_ rawRoots: [Any]) throws -> (byName: [String: TreeFolder], order: [String]) {
        var allRoots: [String: TreeFolder] = [:]
        var order: [String] = []
        for raw in rawRoots {
            let root = try WireObject(raw, keys: ["name", "path"])
            let name = try root.string("name"), path = try root.string("path")
            guard allRoots[name] == nil else { throw BridgeFailure("nativeProtocolError") }
            allRoots[name] = TreeFolder(name: name, fullPath: path, rootPath: path)
            order.append(name)
        }
        return (allRoots, order)
    }

    private static func populateEntries(_ entries: [Any], roots allRoots: [String: TreeFolder]) throws -> Set<UUID> {
        var selectedIDs: Set<UUID> = [], seen: Set<Data> = []
        for raw in entries {
            guard let fields = raw as? [String: Any], let kind = fields["kind"] as? String,
                  kind == "directory" || kind == "file"
            else { throw BridgeFailure("nativeProtocolError") }
            let keys: Set<String> = kind == "file"
                ? ["kind", "root", "path", "selected", "hasCodeMap"] : ["kind", "root", "path"]
            let entry = try WireObject(raw, keys: keys)
            let rootName = try entry.string("root"), path = try entry.string("path")
            let key = Data((rootName + "\0" + path).utf8)
            guard seen.insert(key).inserted, let root = allRoots[rootName]
            else { throw BridgeFailure("nativeProtocolError") }
            let parts = path.components(separatedBy: "/")
            guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." })
            else { throw BridgeFailure("nativeProtocolError") }
            let directories = kind == "directory" ? parts[...] : parts.dropLast()
            let parent = Self.folder(directories, root: root)
            if kind == "file" {
                let id = UUID(), name = parts[parts.count - 1]
                let file = FileTreeFileSnapshot(id: id, name: name, fileExtension: (name as NSString).pathExtension,
                    hasCodeMap: try entry.boolean("hasCodeMap"))
                parent.files.append(file)
                if try entry.boolean("selected") { selectedIDs.insert(id) }
            }
        }
        return selectedIDs
    }

    private static func scopedRoots(
        _ value: Any,
        roots allRoots: [String: TreeFolder],
        order: [String]
    ) throws -> [TreeFolder] {
        if value is NSNull {
            return order.compactMap { allRoots[$0] }
        } else {
            let scope = try WireObject(value, keys: ["root", "path"])
            guard let root = allRoots[try scope.string("root")] else { throw BridgeFailure("nativeProtocolError") }
            let path = try scope.string("path")
            var folder = root
            if !path.isEmpty {
                for part in path.components(separatedBy: "/") {
                    guard let child = folder.folders[Data(part.utf8)]
                    else { throw BridgeFailure("nativeProtocolError") }
                    folder = child
                }
            }
            return [folder]
        }
    }

    private static func folder(_ parts: ArraySlice<String>, root: TreeFolder) -> TreeFolder {
        var parent = root
        for part in parts {
            let key = Data(part.utf8)
            if let existing = parent.folders[key] { parent = existing } else {
                let created = TreeFolder(
                    name: part,
                    fullPath: (parent.fullPath as NSString).appendingPathComponent(part), rootPath: root.rootPath
                )
                parent.folders[key] = created
                parent = created
            }
        }
        return parent
    }

    func render() -> [String: Any] {
        if mode == "selected", selectedIDs.isEmpty {
            return ["kind": "fileTree", "tree": "No files are selected.", "rootsCount": 0, "note": "Selection is empty"]
        }
        let snapshot = FileTreeSelectionSnapshot(roots: roots.map { $0.snapshot() }, selectedFileIDs: selectedIDs,
            mode: mode, showFullPaths: showFullPaths,
            onlyIncludeRootsWithSelectedFiles: onlyIncludeRootsWithSelectedFiles,
            includeLegend: includeLegend, showCodeMapMarkers: showCodeMapMarkers, maxDepth: depth)
        return ["kind": "fileTree", "tree": WorkspaceFileTreePresentationRenderer.render(snapshot),
            "rootsCount": roots.count, "note": NSNull()]
    }
}
