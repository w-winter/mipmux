import Foundation

enum AgentProviderKind: String {
    case codexExec
    case generic
}

enum PromptEnhancementMode: String {
    case fullRewrite
    case augment
    case preserve
}

enum ContextBuilderDefaults {
    static let questionTimeoutSeconds: TimeInterval = 300
}

struct DiscoveryPromptInput {
    let budget: Int
    let runtime: AgentProviderKind
    let mode: PromptEnhancementMode
    let questions: Bool
    let responseType: String?
    let instructions: String?
    let timeout: Int
    let restrictReviewGit: Bool
    let reviewRoots: [String]

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: [
            "kind", "tokenBudget", "runtime", "enhancementMode", "allowClarifyingQuestions",
            "responseType", "instructions", "questionTimeoutSeconds", "restrictsReviewGitToExplicitReadOnly",
            "reviewRootNames"
        ])
        budget = try object.count("tokenBudget")
        guard let runtime = AgentProviderKind(rawValue: try object.string("runtime")),
              let mode = PromptEnhancementMode(rawValue: try object.string("enhancementMode")),
              let roots = object.fields["reviewRootNames"] as? [String]
        else { throw BridgeFailure("nativeProtocolError") }
        self.runtime = runtime
        self.mode = mode
        questions = try object.boolean("allowClarifyingQuestions")
        restrictReviewGit = try object.boolean("restrictsReviewGitToExplicitReadOnly")
        reviewRoots = roots
        responseType = object.fields["responseType"] is NSNull ? nil : try object.string("responseType")
        instructions = object.fields["instructions"] is NSNull ? nil : try object.string("instructions")
        timeout = try object.count("questionTimeoutSeconds")
    }

    func render() -> [String: Any] {
        ["kind": "discoveryPrompt", "text": SystemPromptService.discoverPrompt(
            tokenBudget: budget, agentKind: runtime, enhancementMode: mode, allowClarifyingQuestions: questions,
            responseType: responseType, instructions: instructions, questionTimeoutSeconds: TimeInterval(timeout),
            restrictsReviewGitToExplicitReadOnly: restrictReviewGit, reviewRootNames: reviewRoots
        )]
    }
}
