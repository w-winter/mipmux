import Foundation

struct ContextBuilderMetaPrompt {
    let title: String
    let content: String
}

struct DiscoveryMessageInput {
    private let text: String

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: [
            "kind", "tokenBudget", "fileTree", "currentPrompt", "discoveryInstructions", "contextBuilderPrompts"
        ])
        guard let fileTree = object.fields["fileTree"] as? String,
              let currentPrompt = object.fields["currentPrompt"] as? String,
              let instructions = object.fields["discoveryInstructions"] as? String,
              let rawPrompts = object.fields["contextBuilderPrompts"] as? [Any]
        else { throw BridgeFailure("nativeProtocolError") }
        let prompts = try rawPrompts.map { raw -> ContextBuilderMetaPrompt in
            let prompt = try WireObject(raw, keys: ["title", "content"])
            guard let title = prompt.fields["title"] as? String, let content = prompt.fields["content"] as? String
            else { throw BridgeFailure("nativeProtocolError") }
            return ContextBuilderMetaPrompt(title: title, content: content)
        }
        text = try RPCEContextBuilderMessage.makeUserMessage(
            fileTree: fileTree, userPrompt: currentPrompt, discoverInstructions: instructions,
            adjustedBudget: object.count("tokenBudget"),
            metaPromptText: RPCEContextBuilderMetaPrompts.promptText(for: prompts)
        )
    }

    func render() -> [String: Any] {
        ["kind": "discoveryMessage", "text": text]
    }
}
