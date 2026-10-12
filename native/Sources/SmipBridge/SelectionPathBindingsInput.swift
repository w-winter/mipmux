import Foundation

struct SelectionPathBindingsInput {
    private let paths: [String]

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "paths"])
        guard let paths = input.fields["paths"] as? [String] else { throw BridgeFailure("nativeProtocolError") }
        self.paths = paths.map { StandardizedPath.absolute(($0 as NSString).expandingTildeInPath) }
    }

    func render() -> [String: Any] {
        ["kind": "selectionPathBindings", "paths": paths]
    }
}
