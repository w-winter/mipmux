import Foundation

struct SelectionInputParsing {
    private let parsed: RPCESelectionInputParser.ManageSelectionInputs

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["kind", "paths", "slices"])
        guard let paths = input.fields["paths"] as? [String] else { throw BridgeFailure("nativeProtocolError") }
        let bytes = try JSONSerialization.data(withJSONObject: input.value("slices"), options: [.fragmentsAllowed])
        let slices = try JSONDecoder().decode(SelectionJSONValue.self, from: bytes)
        parsed = RPCESelectionInputParser().parseManageSelectionInputs(rawPaths: paths, slicesValue: slices)
    }

    func render() -> [String: Any] {
        ["kind": "selectionInputs", "paths": parsed.paths,
         "slices": parsed.sliceInputs.map { ["path": $0.path, "ranges": $0.ranges.map(\.wireJSON)] },
         "sliceErrors": parsed.sliceErrors, "hadExplicitSliceSpec": parsed.hadExplicitSliceSpec]
    }
}
