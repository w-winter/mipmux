import CoreFoundation
import Foundation

indirect enum Value {
    case string(String), int(Int), double(Double), bool(Bool), array([Value]), object([String: Value]), null

    init(_ raw: Any) throws {
        switch raw {
        case is NSNull: self = .null
        case let value as String: self = .string(value)
        case let value as NSNumber:
            if CFGetTypeID(value) == CFBooleanGetTypeID() {
                self = .bool(value.boolValue)
            } else if value.doubleValue >= Double(Int.min), value.doubleValue < Double(Int.max),
                      value.doubleValue == Double(value.intValue) {
                self = .int(value.intValue)
            } else {
                self = .double(value.doubleValue)
            }
        case let values as [Any]: self = try .array(values.map(Value.init))
        case let values as [String: Any]: self = try .object(values.mapValues(Value.init))
        default: throw BridgeFailure("nativeProtocolError")
        }
    }

    var stringValue: String? {
        if case let .string(value) = self { value } else { nil }
    }

    var intValue: Int? {
        if case let .int(value) = self { value } else { nil }
    }

    var boolValue: Bool? {
        if case let .bool(value) = self { value } else { nil }
    }

    var arrayValue: [Value]? {
        if case let .array(value) = self { value } else { nil }
    }

    var objectValue: [String: Value]? {
        if case let .object(value) = self { value } else { nil }
    }

    var json: Any {
        switch self {
        case let .string(value): value
        case let .int(value): value
        case let .double(value): value
        case let .bool(value): value
        case let .array(value): value.map(\.json)
        case let .object(value): value.mapValues(\.json)
        case .null: NSNull()
        }
    }
}

enum MCPError: LocalizedError {
    case invalidParams(String)
    var errorDescription: String? {
        switch self {
        case let .invalidParams(message): message
        }
    }
}

enum Elicitation {
    struct RequestSchema {
        let title: String?
        let description: String?
        let properties: [String: Value]
        let required: [String]?

        var json: [String: Any] {
            var result: [String: Any] = ["type": "object", "properties": properties.mapValues(\.json)]
            if let title { result["title"] = title }
            if let description { result["description"] = description }
            if let required { result["required"] = required }
            return result
        }
    }
}
