// Retained source layout and diagnostics; CCCC enforces configured complexity limits.
// swiftlint:disable opening_brace
// Derived from the RPCE-pinned Swift MCP SDK 5716de85a976a8f70dedc9cb000e50aaa0d8cc5b.
// Modified: retain only consumed read accessors and decoding; use an executable-local type name.
import struct Foundation.Data
import class Foundation.JSONDecoder
import class Foundation.JSONEncoder

/// A codable value.
public enum SelectionJSONValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case data(mimeType: String? = nil, Data)
    case array([SelectionJSONValue])
    case object([String: SelectionJSONValue])
    /// Returns the `Int` value if the value is an `integer`,
    /// otherwise returns `nil`.
    public var intValue: Int? {
        guard case let .int(value) = self else { return nil }
        return value
    }

    /// Returns the `String` value if the value is a `string`,
    /// otherwise returns `nil`.
    public var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    /// Returns the `[SelectionJSONValue]` value if the value is an `array`,
    /// otherwise returns `nil`.
    public var arrayValue: [SelectionJSONValue]? {
        guard case let .array(value) = self else { return nil }
        return value
    }

    /// Returns the `[String: SelectionJSONValue]` value if the value is an `object`,
    /// otherwise returns `nil`.
    public var objectValue: [String: SelectionJSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }
}

extension SelectionJSONValue: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            if Data.isDataURL(string: value),
               case let (mimeType, data)? = Data.parseDataURL(value)
            {
                self = .data(mimeType: mimeType, data)
            } else {
                self = .string(value)
            }
        } else if let value = try? container.decode([SelectionJSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: SelectionJSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "SelectionJSONValue type not found"
            )
        }
    }
}

// swiftlint:enable opening_brace
