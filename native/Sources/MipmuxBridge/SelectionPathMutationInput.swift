import Foundation

struct SelectionPathMutationInput {
    private enum Mutation {
        case add(String), remove(String), promote, demote
    }

    private let selection: StoredSelection
    private let catalog: SelectionCatalog
    private let mutation: Mutation
    private let paths: [String]
    private let rawPaths: [String]

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "selection", "catalog", "mutation"])
        selection = try StoredSelection(wire: input.value("selection"))
        guard let fields = try input.value("mutation") as? [String: Any],
              let operation = fields["op"] as? String,
              let paths = fields["paths"] as? [String], let rawPaths = fields["rawPaths"] as? [String]
        else { throw BridgeFailure("nativeProtocolError") }
        self.paths = paths
        self.rawPaths = rawPaths
        if operation == "add" || operation == "remove" {
            let request = try WireObject(fields, keys: ["op", "mode", "paths", "rawPaths"])
            let mode = try request.string("mode")
            guard mode == "full" || mode == "codemap_only" else { throw BridgeFailure("nativeProtocolError") }
            mutation = operation == "add" ? .add(mode) : .remove(mode)
        } else {
            _ = try WireObject(fields, keys: ["op", "paths", "rawPaths"])
            mutation = switch operation {
            case "promote": .promote
            case "demote": .demote
            default: throw BridgeFailure("nativeProtocolError")
            }
        }
        let captured = try WireObject(input.value("catalog"), keys: ["roots", "materialization"])
        guard let roots = captured.fields["roots"] as? [Any],
              let outcomes = captured.fields["materialization"] as? [Any]
        else { throw BridgeFailure("nativeProtocolError") }
        catalog = try SelectionCatalog(wireRoots: roots, outcomes: outcomes, paths: paths)
    }

    func render() async -> [String: Any] {
        let service = RPCESelectionCandidateResolver(store: catalog)
        switch mutation {
        case let .add(mode):
            let value = await service.addPaths(existing: selection, paths: paths, rawPaths: rawPaths, mode: mode)
            return ["kind": "selectionPathMutation", "op": "add", "selection": value.selection.wireJSON,
                    "invalidPaths": value.invalidPaths, "resolvedMap": value.resolvedMap, "mutated": value.mutated,
                    "codemapUnavailable": value.codemapUnavailable]
        case let .remove(mode):
            let value = await service.removePaths(existing: selection, paths: paths, rawPaths: rawPaths, mode: mode)
            return ["kind": "selectionPathMutation", "op": "remove", "selection": value.selection.wireJSON,
                    "invalidPaths": value.invalidPaths, "resolvedMap": value.resolvedMap, "mutated": value.mutated]
        case .promote:
            let value = await service.promotePaths(existing: selection, paths: paths, rawPaths: rawPaths)
            return ["kind": "selectionPathMutation", "op": "promote", "selection": value.selection.wireJSON,
                    "invalidPaths": value.invalidPaths, "mutated": value.mutated,
                    "validCandidateCount": value.validCandidateCount]
        case .demote:
            let value = await service.demotePaths(existing: selection, paths: paths, rawPaths: rawPaths)
            return ["kind": "selectionPathMutation", "op": "demote", "selection": value.selection.wireJSON,
                    "invalidPaths": value.invalidPaths, "mutated": value.mutated,
                    "codemapUnavailable": value.codemapUnavailable, "validCandidateCount": value.validCandidateCount]
        }
    }
}
