import Foundation

extension SearchPathClause {
    var wire: [String: Any] {
        switch self {
        case let .exactFile(absPath, relPath, restrictedRootPath):
            ["kind": "exactFile", "absPath": absPath, "relPath": relPath,
             "restrictedRootPath": Self.nullable(restrictedRootPath)]
        case let .exactFolder(absLower, relLower, restrictedRootPath):
            ["kind": "exactFolder", "absLower": absLower, "relLower": relLower,
             "restrictedRootPath": Self.nullable(restrictedRootPath)]
        case let .glob(pattern, restrictedRootPath):
            ["kind": "glob", "pattern": pattern, "restrictedRootPath": Self.nullable(restrictedRootPath)]
        case let .legacyPrefix(candidateLower): ["kind": "prefix", "candidateLower": candidateLower]
        }
    }

    private static func nullable(_ value: String?) -> Any {
        guard let value else { return NSNull() }
        return value
    }
}

extension RPCESearchScopeParsing.SearchScopeParseResult {
    init(wire value: Any) throws {
        let input = try WireObject(value, keys: ["spec", "issues", "freshnessRootRefs", "exactClauses"])
        let spec = try WireObject(input.value("spec"), keys: ["caseInsensitive", "clauses"])
        guard let clauses = try spec.value("clauses") as? [Any],
              let issues = try input.value("issues") as? [String],
              let refs = try input.value("freshnessRootRefs") as? [Any],
              let exact = try input.value("exactClauses") as? [Any]
        else { throw BridgeFailure("nativeProtocolError") }
        self.spec = try SearchPathFilterSpec(caseInsensitive: spec.boolean("caseInsensitive"),
                                             clauses: clauses.map(SearchScopeFilterInput.clause))
        self.issues = issues
        freshnessRootRefs = try refs.map { value in
            let root = try WireObject(value, keys: ["id", "name", "path"])
            guard let id = try UUID(uuidString: root.string("id")) else { throw BridgeFailure("nativeProtocolError") }
            return try WorkspaceRootRef(id: id, name: root.string("name"), fullPath: root.string("path"))
        }
        var indices: Set<Int> = []
        exactClauses = try exact.map { value in
            let clause = try WireObject(value, keys: ["clauseIndex", "rootID", "relativePath", "missingClauses"])
            let index = try clause.count("clauseIndex")
            guard index < clauses.count, indices.insert(index).inserted,
                  let rootID = try UUID(uuidString: clause.string("rootID")),
                  let missing = try clause.value("missingClauses") as? [Any]
            else { throw BridgeFailure("nativeProtocolError") }
            return try RPCESearchScopeParsing.ExactSearchScopeClause(
                clauseIndex: index, rootID: rootID, relativePath: clause.string("relativePath"),
                missingClauses: missing.map(SearchScopeFilterInput.clause)
            )
        }
    }

    var wire: [String: Any] {
        ["spec": ["caseInsensitive": spec.caseInsensitive, "clauses": spec.clauses.map(\.wire)],
         "issues": issues,
         "freshnessRootRefs": freshnessRootRefs.map { ["id": $0.id.uuidString, "name": $0.name,
                                                       "path": $0.standardizedFullPath] },
         "exactClauses": exactClauses.map { [
             "clauseIndex": $0.clauseIndex, "rootID": $0.rootID.uuidString,
             "relativePath": $0.relativePath, "missingClauses": $0.missingClauses.map(\.wire)
         ] }]
    }
}
