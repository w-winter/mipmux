import Foundation

/// RPCE ContextBuilderAgentViewModel.swift:4079-4149; captured input replaces tab/storage lookup.
/// Structural task/tree/hint framing is checked against the source renderer.
enum RPCEContextBuilderMessage {
    static func makeUserMessage(
        fileTree: String,
        userPrompt: String,
        discoverInstructions: String,
        metadata: String) -> String {
        var message = ""

        if !fileTree.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            message += """
            <file_map>
            \(fileTree)
            </file_map>

            """
        }

        // Always include current prompt content if not empty - the system prompt controls what the agent does with it
        // (augment mode: preserve verbatim, preserve mode: don't touch, fullRewrite mode: rewrite completely)
        if !userPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            message += """
            <current_prompt_content>
            \(userPrompt)
            </current_prompt_content>

            """
        }

        if !discoverInstructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            message += """
            <discover_instructions>
            \(discoverInstructions)
            </discover_instructions>

            """
        }

        message += metadata

        return message
    }
}
