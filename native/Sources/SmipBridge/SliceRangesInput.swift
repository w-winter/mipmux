import Foundation

extension LineRange {
    init(wire value: Any) throws {
        let range = try WireObject(value, keys: ["start", "end", "description"])
        let start = try range.count("start"), end = try range.count("end")
        guard start > 0, end >= start else { throw BridgeFailure("nativeProtocolError") }
        let description = range.fields["description"] is NSNull ? nil : try range.string("description")
        self.init(start: start, end: end, description: description)
    }

    var wireJSON: [String: Any] {
        ["start": start, "end": end, "description": description.map { $0 as Any } ?? NSNull()]
    }
}

struct SliceRangesInput {
    private let ranges: [LineRange]

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: ["kind", "op", "base", "ranges"])
        guard let base = object.fields["base"] as? [Any], let incoming = object.fields["ranges"] as? [Any]
        else { throw BridgeFailure("nativeProtocolError") }
        let existing = try base.map { try LineRange(wire: $0) }, next = try incoming.map { try LineRange(wire: $0) }
        ranges = switch try object.string("op") {
        case "normalize": SliceRangeMath.normalize(next)
        case "coalesce": SliceRangeMath.coalesce(existing, next)
        case "subtract": SliceRangeMath.subtract(existing, removing: next)
        default: throw BridgeFailure("nativeProtocolError")
        }
    }

    func render() -> [String: Any] {
        ["kind": "sliceRanges", "ranges": ranges.map(\.wireJSON)]
    }
}
