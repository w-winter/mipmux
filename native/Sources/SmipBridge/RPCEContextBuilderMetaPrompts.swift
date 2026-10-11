import Foundation

/// RPCE ContextBuilderPromptsOverlay.swift:156-161; selected prompts arrive in storage order.
enum RPCEContextBuilderMetaPrompts {
    static func promptText(for selected: [ContextBuilderMetaPrompt]) -> String? {
        guard !selected.isEmpty else { return nil }

        return selected
            .map { "<meta prompt=\"\($0.title)\">\n\($0.content)\n</meta prompt>" }
            .joined(separator: "\n\n")
    }
}
