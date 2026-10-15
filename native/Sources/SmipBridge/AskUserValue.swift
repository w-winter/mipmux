import Foundation

typealias Value = SelectionJSONValue

extension SelectionJSONValue {
    init(_ raw: Any) throws {
        self = try JSONDecoder().decode(
            Self.self,
            from: JSONSerialization.data(withJSONObject: raw, options: [.fragmentsAllowed])
        )
    }

    var boolValue: Bool? {
        if case let .bool(value) = self { value } else { nil }
    }

    var json: Any {
        get throws {
            switch self {
            case let .string(value): value
            case let .int(value): value
            case let .double(value): value
            case let .bool(value): value
            case let .array(value): try value.map { try $0.json }
            case let .object(value): try value.mapValues { try $0.json }
            case .null: NSNull()
            case .data: throw BridgeFailure("nativeProtocolError")
            }
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
            get throws {
                var result: [String: Any] = try ["type": "object", "properties": properties.mapValues { try $0.json }]
                if let title { result["title"] = title }
                if let description { result["description"] = description }
                if let required { result["required"] = required }
                return result
            }
        }
    }
}
