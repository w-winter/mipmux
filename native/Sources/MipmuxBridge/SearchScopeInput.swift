import Foundation

enum SearchScopeInput {
    case parse(SelectionCatalog, [String], Bool)
    case refresh(SelectionCatalog, RPCESearchScopeParsing.SearchScopeParseResult)

    init(_ value: Any) throws {
        guard let fields = value as? [String: Any], let kind = fields["kind"] as? String
        else { throw BridgeFailure("nativeProtocolError") }
        switch kind {
        case "parseSearchScope":
            let input = try WireObject(value, keys: ["kind", "roots", "paths", "caseInsensitive"])
            guard let roots = try input.value("roots") as? [Any], let paths = try input.value("paths") as? [String]
            else { throw BridgeFailure("nativeProtocolError") }
            self = try .parse(SelectionCatalog(wireRoots: roots, outcomes: [], paths: []), paths,
                              input.boolean("caseInsensitive"))
        case "refreshSearchScope":
            let input = try WireObject(value, keys: ["kind", "roots", "scope"])
            guard let roots = try input.value("roots") as? [Any] else { throw BridgeFailure("nativeProtocolError") }
            self = try .refresh(
                SelectionCatalog(wireRoots: roots, outcomes: [], paths: []), .init(wire: input.value("scope"))
            )
        default: throw BridgeFailure("nativeProtocolError")
        }
    }

    func render() async -> [String: Any] {
        let result: RPCESearchScopeParsing.SearchScopeParseResult = switch self {
        case let .parse(catalog, paths, caseInsensitive):
            await RPCESearchScopeParsing.parseSearchScopePaths(paths, caseInsensitive: caseInsensitive,
                                                               rootScope: .visibleWorkspace, store: catalog)
        case let .refresh(catalog, parsed):
            await RPCESearchScopeParsing.refreshExactSearchScopeClauses(parsed, store: catalog)
        }
        return ["kind": "searchScopeParsed", "scope": result.wire]
    }
}
