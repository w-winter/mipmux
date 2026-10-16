import Foundation

struct SearchScopeFilterInput {
    private let snapshots: [FileSearchPathSnapshot]
    private let spec: SearchPathFilterSpec

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "snapshots", "clauses", "caseInsensitive"])
        guard let snapshots = try input.value("snapshots") as? [Any],
              let clauses = try input.value("clauses") as? [Any]
        else { throw BridgeFailure("nativeProtocolError") }
        self.snapshots = try snapshots.map { value in
            let fields = try WireObject(value, keys: [
                "standardizedFullPath", "standardizedRelativePath", "standardizedRootPath", "clientDisplayPath"
            ])
            return try FileSearchPathSnapshot(
                standardizedFullPath: fields.string("standardizedFullPath"),
                standardizedRelativePath: fields.string("standardizedRelativePath"),
                standardizedRootPath: fields.string("standardizedRootPath"),
                clientDisplayPath: fields.string("clientDisplayPath")
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
