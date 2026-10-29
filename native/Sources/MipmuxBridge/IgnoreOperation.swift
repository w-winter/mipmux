import Foundation

enum IgnoreOperation {
    case snapshot(IgnoreRulesInput)
    case capture(IgnoreCaptureInput)
    case hierarchy(IgnoreHierarchyInput)
    case walk(IgnoreWalkInput)
    case gitExcludes(GitExcludeCaptureInput)

    static func recognizes(_ kind: String) -> Bool {
        ["queryIgnoreRules", "captureIgnoreInputs", "queryIgnoreHierarchy", "walkDirectory", "captureGitExcludeInputs"]
            .contains(kind)
    }

    init(_ value: Any, kind: String) throws {
        switch kind {
        case "queryIgnoreRules": self = try .snapshot(IgnoreRulesInput(value))
        case "captureIgnoreInputs": self = try .capture(IgnoreCaptureInput(value))
        case "queryIgnoreHierarchy": self = try .hierarchy(IgnoreHierarchyInput(value))
        case "walkDirectory": self = try .walk(IgnoreWalkInput(value))
        case "captureGitExcludeInputs": self = try .gitExcludes(GitExcludeCaptureInput(value))
        default: throw BridgeFailure("nativeProtocolError")
        }
    }

    func render(files: ConfinedFiles, walks: IgnoreWalks, request: Request) async throws -> [String: Any] {
        switch self {
        case let .snapshot(input): input.render()
        case let .capture(input): try files.captureIgnoreInputs(input)
        case let .hierarchy(input): try await input.render(files: files)
        case let .walk(input): try await input.render(files: files, walks: walks, request: request)
        case let .gitExcludes(input): try input.render(files: files)
        }
    }
}
