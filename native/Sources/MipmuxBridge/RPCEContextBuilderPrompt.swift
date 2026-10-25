// Derived review detection from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
import Foundation
import RepoPromptCodeMapCore

enum RPCEContextBuilderPrompt {
    static func compose(_ template: DiscoveryTemplate,
                        input: DiscoveryPromptInput) throws -> (system: String, metadata: String) {
        typealias Value = DiscoveryTemplate.Value
        let languages = Array(Set(CodeMapSyntaxEngine.extensionToLanguage.values)).sorted().map(\.displayName)
            .joined(separator: ", ")
        func scalar(_ value: Value) throws -> String {
            switch value {
            case .budget: String(input.budget)
            case .languages: languages
            case .questionTimeout: String(input.timeout)
            case .haltStep: input.questions ? "6" : "5"
            default: throw BridgeFailure("nativeOperationFailed")
            }
        }
        let mode = input.mode.sections
        let handoff = try template.render(mode.handoff, resolve: scalar)
        let success = try template.render(mode.success, resolve: scalar)
        let antiPatterns = try template.render(mode.antiPatterns, resolve: scalar)
        let checklist = try template.render(mode.checklist, resolve: scalar)
        let codemodeTool = input.codemode ? try template.render(.codemodeTool, resolve: scalar) : ""
        let questionTool = input.questions ? try template.render(.clarificationTool, resolve: scalar) : ""
        let questionGuidance = input.questions ? try template.render(.clarificationGuidance, resolve: scalar) : ""
        let approval = input.questions ? try template.render(.clarificationApproval, resolve: scalar) : ""
        let review: String = if shouldUseReviewModeGuidance(
            responseType: input.purpose.rawValue,
            instructions: input.task) {
            if input.restrictReviewGit {
                try readOnlyReviewGuidance(template, roots: input.reviewRoots, scalar: scalar)
            } else {
                try template.render(.reviewArtifacts, resolve: scalar)
            }
        } else {
            ""
        }
        let slots: [Value: String] = [.handoff: handoff, .handoffSuccess: success, .handoffAntiPatterns: antiPatterns,
                                      .handoffChecklist: checklist, .codemodeTool: codemodeTool,
                                      .clarificationTool: questionTool,
                                      .clarificationGuidance: questionGuidance,
                                      .approvalStep: approval, .reviewGuidance: review]
        let system = try template.render(.system) { value in
            if let fragment = slots[value] { return fragment }
            return try scalar(value)
        }
        return try (system, template.render(.startupMetadata, resolve: scalar))
    }

    private static func readOnlyReviewGuidance(_ template: DiscoveryTemplate, roots: [String],
                                               scalar: (DiscoveryTemplate.Value) throws -> String) throws -> String {
        let rootGuidance: String
        if let first = roots.first {
            // JSONEncoder guarantees UTF-8, so this conversion cannot fail.
            // swiftlint:disable:next optional_data_string_conversion
            let rootJSON = try String(decoding: JSONEncoder().encode(first), as: UTF8.self)
            let rootNames = roots.map { "`\($0)`" }.joined(separator: ", ")
            rootGuidance = try template.render(.reviewRootsNamed) { value in
                switch value {
                case .rootNames: rootNames
                case .exampleRootJSON: rootJSON
                default: try scalar(value)
                }
            }
        } else {
            rootGuidance = try template.render(.reviewRootsLookup, resolve: scalar)
        }
        return try template.render(.reviewReadOnly) { value in
            value == .reviewRootGuidance ? rootGuidance : try scalar(value)
        }
    }

    private static func shouldUseReviewModeGuidance(responseType: String?, instructions: String?) -> Bool {
        if responseType == "review" {
            return true
        }

        let haystack = instructions?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        guard !haystack.isEmpty else { return false }

        // Phrase hotwords – these strongly signal code-review-with-diffs intent.
        let phraseHotwords = [
            "review mode",
            "code review",
            "review changes",
            "review the changes",
            "review the diff",
            "review the pr",
            "review this pr",
            "review pull request",
            "review my changes",
            "review my pr",

            "git diff",
            "pull request",
            "pr review",
            "compare branch",
            "compare main",
            "compare master"
        ]
        if phraseHotwords.contains(where: { haystack.contains($0) }) {
            return true
        }

        // Token-level detection – only trigger when git AND diff both appear,
        // signalling a concrete "look at the git diff" request rather than a
        // general "review" of the project.
        let tokenSeparators = CharacterSet.alphanumerics.inverted
        let tokens = Set(
            haystack
                .components(separatedBy: tokenSeparators)
                .filter { !$0.isEmpty })

        return tokens.contains("git") && (tokens.contains("diff") || tokens.contains("diffs"))
    }
}

struct DiscoveryHandoffSections {
    let handoff: DiscoveryTemplate.Section
    let success: DiscoveryTemplate.Section
    let antiPatterns: DiscoveryTemplate.Section
    let checklist: DiscoveryTemplate.Section
}

extension PromptEnhancementMode {
    var sections: DiscoveryHandoffSections {
        switch self {
        case .fullRewrite:
            DiscoveryHandoffSections(handoff: .rewriteHandoff, success: .rewriteSuccess,
                                     antiPatterns: .rewriteAntiPatterns, checklist: .rewriteChecklist)
        case .augment:
            DiscoveryHandoffSections(handoff: .augmentHandoff, success: .augmentSuccess,
                                     antiPatterns: .augmentAntiPatterns, checklist: .augmentChecklist)
        case .preserve:
            DiscoveryHandoffSections(handoff: .preserveHandoff, success: .preserveSuccess,
                                     antiPatterns: .preserveAntiPatterns, checklist: .preserveChecklist)
        }
    }
}
