import Foundation

/// Captured selection has canonical absolute keys. Desktop raw/legacy-key recovery is not a wire contract.
enum StoredSelectionPathNormalization {
    static func standardizedPath(_ path: String) -> String? {
        path.isEmpty ? nil : path
    }

    static func standardizedPaths(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        return paths.filter { seen.insert($0).inserted }
    }

    static func standardizedSlices(_ slices: [String: [LineRange]]) -> [String: [LineRange]] {
        slices.filter { !$0.value.isEmpty }
    }
}

struct SelectionTransitionInput {
    private let result: StoredSelection

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "selection", "mutation"])
        let selection = try StoredSelection(wire: input.value("selection"))
        guard let mutation = try input.value("mutation") as? [String: Any], let kind = mutation["kind"] as? String
        else { throw BridgeFailure("nativeProtocolError") }
        let service = RPCESelectionTransitions()
        if kind == "fullFiles" {
            let fields = try WireObject(mutation, keys: ["kind", "op", "paths"])
            let mode = try fields.string("op")
            guard mode == "add" || mode == "remove" else { throw BridgeFailure("nativeProtocolError") }
            result = try service.mutatePreResolvedFullFilePaths(base: selection,
                                                                absolutePaths: StoredSelection
                                                                    .paths(fields.value("paths")),
                                                                mode: mode == "add" ? .add : .remove)
        } else if kind == "representation" {
            let fields = try WireObject(mutation, keys: ["kind", "target", "paths"])
            let target: WorkspacePreResolvedSelectionTargetState = switch try fields.string("target") {
            case "full": .full
            case "codemapOnly": .codemapOnly
            case "unselected": .unselected
            default: throw BridgeFailure("nativeProtocolError")
            }
            result = try service.setPreResolvedFilePaths(base: selection,
                                                         absolutePaths: StoredSelection.paths(fields.value("paths")),
                                                         targetState: target)
        } else {
            throw BridgeFailure("nativeProtocolError")
        }
    }

    func render() -> [String: Any] {
        ["kind": "selectionTransition", "selection": result.wireJSON]
    }
}

extension StoredSelection {
    init(wire value: Any) throws {
        let object = try WireObject(
            value,
            keys: ["selectedPaths", "manualCodemapPaths", "slices", "codemapAutoEnabled"]
        )
        try self.init(selectedPaths: Self.paths(object.value("selectedPaths")),
                      manualCodemapPaths: Self.paths(object.value("manualCodemapPaths")),
                      slices: Self.slices(object.value("slices")),
                      codemapAutoEnabled: object.boolean("codemapAutoEnabled"))
    }

    static func paths(_ value: Any) throws -> [String] {
        guard let paths = value as? [String], paths.allSatisfy({ canonical($0) })
        else { throw BridgeFailure("nativeProtocolError") }
        return paths
    }

    private static func canonical(_ path: String) -> Bool {
        path.hasPrefix("/") && !path.utf8.contains(0) && (path as NSString).standardizingPath == path
    }

    private static func slices(_ value: Any) throws -> [String: [LineRange]] {
        guard let entries = value as? [String: [Any]] else { throw BridgeFailure("nativeProtocolError") }
        var result: [String: [LineRange]] = [:]
        for (path, ranges) in entries {
            guard canonical(path) else { throw BridgeFailure("nativeProtocolError") }
            result[path] = try ranges.map { try LineRange(wire: $0) }
        }
        return result
    }

    var wireJSON: [String: Any] {
        ["selectedPaths": selectedPaths, "manualCodemapPaths": manualCodemapPaths,
         "slices": slices.mapValues { $0.map(\.wireJSON) }, "codemapAutoEnabled": codemapAutoEnabled]
    }
}
