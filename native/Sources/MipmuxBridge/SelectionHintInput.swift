import Foundation

struct SelectionHintInput {
    private let roots: [WorkspaceRootRef]
    private let paths: [String]
    private let operation: String

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "roots", "paths", "operation"])
        guard let values = input.fields["roots"] as? [Any], !values.isEmpty,
              let paths = input.fields["paths"] as? [String]
        else { throw BridgeFailure("nativeProtocolError") }
        roots = try values.map { value in
            let root = try WireObject(value, keys: ["name", "path"])
            let path = try root.string("path")
            guard path.hasPrefix("/"), !StandardizedPath.containsNUL(path)
            else { throw BridgeFailure("nativeProtocolError") }
            return try WorkspaceRootRef(id: UUID(), name: root.string("name"), fullPath: path)
        }
        self.paths = paths
        operation = try input.string("operation")
    }

    func render() -> [String: Any] {
        ["kind": "selectionHint", "message": RPCESelectionHints.makeSelectionHintError(
            paths: paths, operation: operation, roots: roots
        )]
    }
}
