import Foundation

struct SelectionPreparationInput {
    private enum Mutation {
        case set(
            mode: String,
            paths: [String],
            slices: [WorkspaceSelectionSliceInput],
            errors: [String],
            artifacts: Bool
        )
        case slices(SliceMutationMode, [WorkspaceSelectionSliceInput])
    }

    private let selection: StoredSelection
    private let catalog: SelectionCatalog
    private let mutation: Mutation

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "selection", "catalog", "mutation"])
        selection = try StoredSelection(wire: input.value("selection"))
        guard let raw = try input.value("mutation") as? [String: Any], let kind = raw["kind"] as? String
        else { throw BridgeFailure("nativeProtocolError") }
        let lookupPaths: [String]
        if kind == "set" {
            let fields = try WireObject(
                raw,
                keys: ["kind", "mode", "paths", "slices", "sliceErrors", "hasFullFileArtifactInputs"]
            )
            guard let paths = fields.fields["paths"] as? [String],
                  let errors = fields.fields["sliceErrors"] as? [String]
            else { throw BridgeFailure("nativeProtocolError") }
            let mode = try fields.string("mode")
            guard ["full", "slices", "codemap_only"].contains(mode) else { throw BridgeFailure("nativeProtocolError") }
            let slices = try Self.sliceInputs(fields.value("slices"))
            mutation = try .set(mode: mode, paths: paths, slices: slices, errors: errors,
                                artifacts: fields.boolean("hasFullFileArtifactInputs"))
            lookupPaths = paths + slices.map(\.path)
        } else if kind == "slices" {
            let fields = try WireObject(raw, keys: ["kind", "op", "entries"])
            let mode = try Self.sliceMode(fields.string("op"))
            let entries = try Self.sliceInputs(fields.value("entries"))
            mutation = .slices(mode, entries)
            lookupPaths = entries.map(\.path)
        } else { throw BridgeFailure("nativeProtocolError") }
        let captured = try WireObject(input.value("catalog"), keys: ["roots", "materialization"])
        guard let roots = captured.fields["roots"] as? [Any],
              let outcomes = captured.fields["materialization"] as? [Any]
        else { throw BridgeFailure("nativeProtocolError") }
        catalog = try SelectionCatalog(wireRoots: roots, outcomes: outcomes, paths: lookupPaths)
    }

    private static func sliceMode(_ value: String) throws -> SliceMutationMode {
        switch value {
        case "add": .add
        case "remove": .remove
        case "set": .set
        case "setPaths": .setPaths
        default: throw BridgeFailure("nativeProtocolError")
        }
    }

    private static func sliceInputs(_ value: Any) throws -> [WorkspaceSelectionSliceInput] {
        guard let entries = value as? [Any] else { throw BridgeFailure("nativeProtocolError") }
        return try entries.map { raw in
            let entry = try WireObject(raw, keys: ["path", "ranges"])
            guard let path = entry.fields["path"] as? String, let ranges = entry.fields["ranges"] as? [Any]
            else { throw BridgeFailure("nativeProtocolError") }
            return try WorkspaceSelectionSliceInput(path: path, ranges: ranges.map { try LineRange(wire: $0) })
        }
    }

    func render() async -> [String: Any] {
        let service = RPCESelectionCandidateResolver(store: catalog)
        switch mutation {
        case let .set(mode, paths, slices, errors, artifacts):
            let result = await service.buildManageSelectionSet(paths: paths, slices: slices, sliceErrors: errors,
                                                               mode: mode, existing: selection,
                                                               hasFullFileArtifactInputs: artifacts)
            return ["kind": "selectionBuilt", "selection": result.selection.wireJSON,
                    "invalidPaths": result.invalidPaths, "codemapUnavailable": result.codemapUnavailable]
        case let .slices(mode, entries):
            let result = await service.mutateSlices(base: selection, entries: entries, mode: mode)
            return ["kind": "selectionSlicesChanged", "selection": result.selection.wireJSON,
                    "invalidPaths": result.invalidPaths, "resolvedMap": result.resolvedMap, "mutated": result.mutated]
        }
    }
}
