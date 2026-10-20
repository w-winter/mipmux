import Foundation

/// JSONSerialization drops leading BOM scalars inside strings on Darwin.
/// Decode wire input with JSONDecoder before constructing the field-parsing objects.
private enum WireJSON: Decodable {
    case null
    case boolean(Bool)
    case integer(Int)
    case number(Double)
    case string(String)
    case array([WireJSON])
    case object([String: WireJSON])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Int.self) {
            self = .integer(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([WireJSON].self) {
            self = .array(value)
        } else {
            self = try .object(container.decode([String: WireJSON].self))
        }
    }

    var fieldsValue: Any {
        switch self {
        case .null: NSNull()
        case let .boolean(value): NSNumber(value: value)
        case let .integer(value): NSNumber(value: value)
        case let .number(value): NSNumber(value: value)
        case let .string(value): value
        case let .array(values): values.map(\.fieldsValue)
        case let .object(values): values.mapValues(\.fieldsValue)
        }
    }
}

func decodeWireJSON(_ bytes: Data) throws -> Any {
    try JSONDecoder().decode(WireJSON.self, from: bytes).fieldsValue
}
