import Foundation

struct SearchScopeFilterInput {
    private let snapshots: [FileSearchPathSnapshot]
    private let spec: SearchPathFilterSpec

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "roots", "files", "clauses", "caseInsensitive"])
        guard let rootValues = try input.value("roots") as? [Any],
              let files = try input.value("files") as? [Any],
              let clauses = try input.value("clauses") as? [Any]
        else { throw BridgeFailure("nativeProtocolError") }
        var rootIDs: Set<UUID> = []
        let roots = try rootValues.map { value in
            let root = try WireObject(value, keys: ["id", "name", "path"])
            guard let id = try UUID(uuidString: root.string("id")), rootIDs.insert(id).inserted
            else { throw BridgeFailure("nativeProtocolError") }
            return try WorkspaceRootRef(id: id, name: root.string("name"), fullPath: root.string("path"))
        }
        let rootsByID = Dictionary(uniqueKeysWithValues: roots.map { ($0.id, $0) })
        snapshots = try files.map { value in
            let fields = try WireObject(value, keys: ["rootID", "path"])
            guard let rootID = try UUID(uuidString: fields.string("rootID")),
                  let root = rootsByID[rootID]
            else { throw BridgeFailure("nativeProtocolError") }
            let path = try fields.string("path")
            try PathMatchInput.relativePath(path)
            return FileSearchPathSnapshot(
                standardizedFullPath: StandardizedPath.join(standardizedRoot: root.standardizedFullPath,
                                                            standardizedRelativePath: path),
                standardizedRelativePath: path, standardizedRootPath: root.standardizedFullPath,
                clientDisplayPath: ClientPathFormatter.displayPath(root: root, relativePath: path, visibleRoots: roots)
            )
        }
        spec = try SearchPathFilterSpec(caseInsensitive: input.boolean("caseInsensitive"),
                                        clauses: clauses.map(Self.clause))
    }

    func render() -> [String: Any] {
        let result = filterPathIndicesResult(snapshots: snapshots, spec: spec)
        return ["kind": "searchScopeFiltered", "indices": result.matchedSnapshotIndices,
                "visited": result.visitedSnapshotCount, "cancelled": result.cancelled]
    }

    static func clause(_ value: Any) throws -> SearchPathClause {
        guard let fields = value as? [String: Any], let kind = fields["kind"] as? String
        else { throw BridgeFailure("nativeProtocolError") }
        switch kind {
        case "exactFile":
            let input = try WireObject(value, keys: ["kind", "absPath", "relPath", "restrictedRootPath"])
            return try .exactFile(absPath: input.string("absPath"), relPath: input.string("relPath"),
                                  restrictedRootPath: restrictedRoot(input))
        case "exactFolder":
            let input = try WireObject(value, keys: ["kind", "absLower", "relLower", "restrictedRootPath"])
            return try .exactFolder(absLower: input.string("absLower"), relLower: input.string("relLower"),
                                    restrictedRootPath: restrictedRoot(input))
        case "glob":
            let input = try WireObject(value, keys: ["kind", "pattern", "restrictedRootPath"])
            return try .glob(pattern: input.string("pattern"), restrictedRootPath: restrictedRoot(input))
        case "prefix":
            let input = try WireObject(value, keys: ["kind", "candidateLower"])
            return try .legacyPrefix(candidateLower: input.string("candidateLower"))
        default: throw BridgeFailure("nativeProtocolError")
        }
    }

    private static func restrictedRoot(_ input: WireObject) throws -> String? {
        try input.value("restrictedRootPath") is NSNull ? nil : input.string("restrictedRootPath")
    }
}
