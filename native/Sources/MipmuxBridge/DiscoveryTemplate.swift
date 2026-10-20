import Foundation

struct DiscoveryTemplate {
    enum Section: String, CaseIterable {
        case system
        case startupMetadata = "startup.metadata"
        case rewriteHandoff = "mode.fullRewrite.handoff"
        case rewriteSuccess = "mode.fullRewrite.success"
        case rewriteAntiPatterns = "mode.fullRewrite.antiPatterns"
        case rewriteChecklist = "mode.fullRewrite.checklist"
        case augmentHandoff = "mode.augment.handoff"
        case augmentSuccess = "mode.augment.success"
        case augmentAntiPatterns = "mode.augment.antiPatterns"
        case augmentChecklist = "mode.augment.checklist"
        case preserveHandoff = "mode.preserve.handoff"
        case preserveSuccess = "mode.preserve.success"
        case preserveAntiPatterns = "mode.preserve.antiPatterns"
        case preserveChecklist = "mode.preserve.checklist"
        case clarificationTool = "clarification.tool"
        case clarificationGuidance = "clarification.guidance"
        case clarificationApproval = "clarification.approval"
        case reviewArtifacts = "review.artifacts"
        case reviewReadOnly = "review.readOnly"
        case reviewRootsNamed = "review.roots.named"
        case reviewRootsLookup = "review.roots.lookup"
    }

    enum Value: String {
        case budget = "token_budget"
        case languages = "supported_languages"
        case rootNames = "root_names"
        case exampleRootJSON = "example_root_json"
        case questionTimeout = "question_timeout_seconds"
        case haltStep = "halt_step"
        case handoff
        case handoffSuccess = "handoff_success"
        case handoffAntiPatterns = "handoff_anti_patterns"
        case handoffChecklist = "handoff_checklist"
        case clarificationTool = "clarification_tool"
        case clarificationGuidance = "clarification_guidance"
        case approvalStep = "approval_step"
        case reviewGuidance = "review_guidance"
        case reviewRootGuidance = "review_root_guidance"

        func isAllowed(in section: Section) -> Bool {
            switch self {
            case .rootNames, .exampleRootJSON: section == .reviewRootsNamed
            case .reviewRootGuidance: section == .reviewReadOnly
            case .handoff, .handoffSuccess, .handoffAntiPatterns, .handoffChecklist,
                 .clarificationTool, .clarificationGuidance, .approvalStep, .reviewGuidance:
                section == .system
            default: true
            }
        }
    }

    private enum Segment {
        case literal(String)
        case value(Value)
    }

    private final class OpenSection {
        let name: Section
        let openingLine: Int
        var lines: [String] = []

        init(name: Section, openingLine: Int) {
            self.name = name
            self.openingLine = openingLine
        }
    }

    private let sections: [Section: [Segment]]

    // The delimiter-state parser keeps physical LF positions with its open section.
    // swiftlint:disable:next cyclomatic_complexity
    init(_ text: String) throws {
        let lines = text.utf8.split(separator: 0x0A, omittingEmptySubsequences: false)
            // Splitting a valid String at ASCII LF keeps every UTF-8 fragment valid.
            // swiftlint:disable:next optional_data_string_conversion
            .map { String(decoding: $0, as: UTF8.self) }
        guard lines.count > 1, lines.first == "# mipmux discovery template v1" else {
            throw DiscoveryTemplateDiagnostic.header
        }
        var parsed: [Section: [Segment]] = [:]
        var active: OpenSection?
        for (index, line) in lines.dropFirst().enumerated() {
            let number = index + 2
            if line == "<!-- mipmux:end -->" {
                guard let current = active else {
                    throw DiscoveryTemplateDiagnostic.structure(.unexpectedEnd, line: number)
                }
                parsed[current.name] = try Self.parseValues(current.lines.joined(separator: "\n"),
                                                            section: current.name,
                                                            startingLine: current.openingLine + 1)
                active = nil
            } else if line.hasPrefix("<!-- mipmux:section "), line.hasSuffix(" -->") {
                let name = String(line.dropFirst("<!-- mipmux:section ".count).dropLast(" -->".count))
                guard let section = Section(rawValue: name) else {
                    throw DiscoveryTemplateDiagnostic.structure(.unknownSection, line: number)
                }
                if let current = active {
                    throw DiscoveryTemplateDiagnostic.section(.nested, line: number, section: current.name)
                }
                guard parsed[section] == nil else {
                    throw DiscoveryTemplateDiagnostic.section(.duplicate, line: number, section: section)
                }
                active = OpenSection(name: section, openingLine: number)
            } else if line.contains("<!-- mipmux:") {
                throw DiscoveryTemplateDiagnostic.structure(.malformedMarker, line: number)
            } else if let current = active {
                current.lines.append(line)
            } else if !line.utf8.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) {
                throw DiscoveryTemplateDiagnostic.structure(.outsideContent, line: number)
            }
        }
        if let current = active {
            throw DiscoveryTemplateDiagnostic.section(.unterminated, line: current.openingLine, section: current.name)
        }
        for section in Section.allCases where parsed[section] == nil {
            throw DiscoveryTemplateDiagnostic.missingSection(section)
        }
        sections = parsed
    }

    private static func parseValues(_ body: String, section: Section, startingLine: Int) throws -> [Segment] {
        var segments: [Segment] = []
        var cursor = body.startIndex
        var line = startingLine
        while let start = body.range(of: "{{mipmux", options: .literal, range: cursor ..< body.endIndex) {
            let literal = String(body[cursor ..< start.lowerBound])
            segments.append(.literal(literal))
            line += literal.utf8.count(where: { $0 == 0x0A })
            guard let end = body.range(of: "}}", options: .literal, range: start.upperBound ..< body.endIndex) else {
                throw DiscoveryTemplateDiagnostic.placeholder(.unclosed, line: line, section: section)
            }
            let token = String(body[start.lowerBound ..< end.upperBound])
            guard token.hasPrefix("{{mipmux:") else {
                throw DiscoveryTemplateDiagnostic.placeholder(.malformed, line: line, section: section)
            }
            let name = String(token.dropFirst("{{mipmux:".count).dropLast(2))
            guard let value = Value(rawValue: name) else {
                throw DiscoveryTemplateDiagnostic.placeholder(.unknown, line: line, section: section)
            }
            guard value.isAllowed(in: section) else {
                throw DiscoveryTemplateDiagnostic.placeholder(.disallowed, line: line, section: section)
            }
            segments.append(.value(value))
            cursor = end.upperBound
        }
        segments.append(.literal(String(body[cursor...])))
        return segments
    }

    func render(_ section: Section, resolve: (Value) throws -> String) throws -> String {
        guard let segments = sections[section] else { throw BridgeFailure("nativeOperationFailed") }
        return try segments.map { segment in
            switch segment {
            case let .literal(text): text
            case let .value(value): try resolve(value)
            }
        }.joined()
    }
}

enum DiscoveryTemplateDiagnostic: Error {
    enum StructureReason: String { case unknownSection, unexpectedEnd, malformedMarker, outsideContent }
    enum SectionReason: String { case duplicate, nested, unterminated }
    enum PlaceholderReason: String { case unknown, malformed, unclosed, disallowed }

    case header
    case missingSection(DiscoveryTemplate.Section)
    case structure(StructureReason, line: Int)
    case section(SectionReason, line: Int, section: DiscoveryTemplate.Section)
    case placeholder(PlaceholderReason, line: Int, section: DiscoveryTemplate.Section)

    var wire: [String: Any] {
        switch self {
        case .header:
            ["kind": "header", "line": 1]
        case let .missingSection(section):
            ["kind": "missingSection", "section": section.rawValue]
        case let .structure(reason, line):
            ["kind": "structure", "reason": reason.rawValue, "line": line]
        case let .section(reason, line, section):
            ["kind": "section", "reason": reason.rawValue, "line": line, "section": section.rawValue]
        case let .placeholder(reason, line, section):
            ["kind": "placeholder", "reason": reason.rawValue, "line": line, "section": section.rawValue]
        }
    }
}
