import Foundation

// RPCE ContextBuilderAgentViewModel.swift:4079-4149; captured input replaces tab/storage lookup.
// Retained metadata prose and literal layout are checked against the source renderer.
// swiftlint:disable line_length function_body_length
enum RPCEContextBuilderMessage {
    static func makeUserMessage(
        fileTree: String,
        userPrompt: String,
        discoverInstructions: String,
        adjustedBudget: Int,
        metaPromptText: String?
    ) -> String {
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

        // Include context builder custom prompts (meta prompts) before user instructions
        if let metaPromptText {
            message += """
            \(metaPromptText)

            """
        }

        if !discoverInstructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            message += """
            <discover_instructions>
            \(discoverInstructions)
            </discover_instructions>

            """
        }

        message += """
        <metadata>
        <token_budget>\(adjustedBudget)</token_budget>
        <token_budget_guidance>
        Make a best effort to ensure the complete prompt (including all selected files and context) fits within the prescribed token budget of \(adjustedBudget) tokens.

        Context Optimization Strategy:
        - Selected files use full content, slices, or codemaps (API signatures), according to their selected representation
        - Codemaps provide type definitions, function signatures, and structure without full implementation details
        - Additional codemaps may be automatically included for types referenced by selected files (in 'auto' mode)
        - Use the MCP tools to check current token counts and adjust selection as needed to stay within budget

        Prioritize including files most relevant to the user's task while staying within the token budget.
        For additional files that may not fit, but are important, mention them in the prompt, with a short description for what they contain that may be relevant to the task.
        </token_budget_guidance>
        <output_format>
        The final prompt should be written with clear formatting, isolating important concepts in xml tags, and making use of clean markdown where possible.
        Do not add any outer wrapping for the complete prompt, as it will already be wrapped in <user_instructions>.
        </output_format>
        </metadata>
        """

        return message
    }
}

// swiftlint:enable line_length function_body_length
