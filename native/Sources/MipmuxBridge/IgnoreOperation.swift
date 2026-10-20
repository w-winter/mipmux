import Foundation

enum IgnoreOperation {
    case snapshot(IgnoreRulesInput)
    case capture(IgnoreCaptureInput)
    case hierarchy(IgnoreHierarchyInput)

    static func recognizes(_ kind: String) -> Bool {
        ["queryIgnoreRules", "captureIgnoreInputs", "queryIgnoreHierarchy"].contains(kind)
    }

    init(_ value: Any, kind: String) throws {
        switch kind {
        case "queryIgnoreRules": self = try .snapshot(IgnoreRulesInput(value))
        case "captureIgnoreInputs": self = try .capture(IgnoreCaptureInput(value))
        case "queryIgnoreHierarchy": self = try .hierarchy(IgnoreHierarchyInput(value))
        default: throw BridgeFailure("nativeProtocolError")
        }
    }

    func render(files: ConfinedFiles) async throws -> [String: Any] {
        switch self {
        case let .snapshot(input): input.render()
        case let .capture(input): try files.captureIgnoreInputs(input)
        case let .hierarchy(input): try await input.render(files: files)
        }
    }
}
