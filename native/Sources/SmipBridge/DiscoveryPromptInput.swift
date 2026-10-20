import Foundation

enum PromptEnhancementMode: String {
    case fullRewrite
    case augment
    case preserve
}

enum DiscoveryPurpose: String { case planning, review, investigation }

struct DiscoveryPromptInput {
    let budget: Int
    let template: String
    let mode: PromptEnhancementMode
    let questions: Bool
    let purpose: DiscoveryPurpose
    let task: String
    let timeout: Int
    let restrictReviewGit: Bool
    let reviewRoots: [String]
    let fileTree: String
    let currentPrompt: String
    let discoveryInstructions: String

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: [
            "kind", "template", "tokenBudget", "enhancementMode", "allowClarifyingQuestions",
            "purpose", "task", "questionTimeoutSeconds", "restrictsReviewGitToExplicitReadOnly",
            "reviewRootNames", "fileTree", "currentPrompt", "discoveryInstructions"
        ])
        budget = try object.count("tokenBudget")
        guard let purpose = try DiscoveryPurpose(rawValue: object.string("purpose")),
              let mode = try PromptEnhancementMode(rawValue: object.string("enhancementMode")),
              let roots = object.fields["reviewRootNames"] as? [String]
        else { throw BridgeFailure("nativeProtocolError") }
        self.purpose = purpose
        template = try object.text("template")
        self.mode = mode
        questions = try object.boolean("allowClarifyingQuestions")
        restrictReviewGit = try object.boolean("restrictsReviewGitToExplicitReadOnly")
        reviewRoots = roots
        task = try object.text("task")
        timeout = try object.count("questionTimeoutSeconds")
        guard timeout > 0 else { throw BridgeFailure("nativeProtocolError") }
        fileTree = try object.text("fileTree")
        currentPrompt = try object.text("currentPrompt")
        discoveryInstructions = try object.text("discoveryInstructions")
    }

    func render() throws -> [String: Any] {
        do {
            let admitted = try DiscoveryTemplate(template)
            let rendered = try RPCEContextBuilderPrompt.compose(admitted, input: self)
            return ["kind": "discoveryPrompt", "text": rendered.system,
                    "message": RPCEContextBuilderMessage.makeUserMessage(fileTree: fileTree, userPrompt: currentPrompt,
                                                                         discoverInstructions: discoveryInstructions,
                                                                         metadata: rendered.metadata)]
        } catch let diagnostic as DiscoveryTemplateDiagnostic {
            return ["kind": "discoveryTemplateRejected", "diagnostic": diagnostic.wire]
        }
    }
}
