// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Native JSON adapters replace MCP and app runtime dependencies.
import Foundation

enum MCPAskUserToolProvider {
    nonisolated static func resolvedInteractionTimeoutSeconds(
        _ value: Value?,
        defaultTimeout: TimeInterval
    ) throws -> TimeInterval {
        guard let value else { return defaultTimeout }
        guard let timeoutInt = value.intValue, timeoutInt > 0 else {
            throw MCPError.invalidParams("timeout_seconds must be a positive integer.")
        }
        return TimeInterval(timeoutInt)
    }

    struct ParsedAskUserInteraction {
        let interaction: AgentAskUserInteraction
        let includeLegacyResponse: Bool
    }

    // swiftlint:disable:next function_body_length
    nonisolated static func parseAskUserInteraction(
        args: [String: Value], defaultTimeout: TimeInterval
    ) throws -> ParsedAskUserInteraction {
        let hasStructuredQuestions = args["questions"] != nil
        let legacyKeys = ["question", "options", "multi_select"]
        let misplacedTopLevelQuestionKeys = ["allow_custom", "allows_custom", "allows_multiple"]
        let hasLegacyInput = legacyKeys.contains { args[$0] != nil }
        if hasStructuredQuestions, hasLegacyInput {
            throw MCPError
                .invalidParams(
                    "ask_user accepts either structured questions or legacy question/options/multi_select, not both."
                )
        }
        if hasStructuredQuestions, let misplacedKey = misplacedTopLevelQuestionKeys.first(where: { args[$0] != nil }) {
            throw MCPError
                .invalidParams(
                    "ask_user structured questions must put '\(misplacedKey)' on each question, not at the top level."
                )
        }

        let timeoutSeconds = try resolvedInteractionTimeoutSeconds(
            args["timeout_seconds"],
            defaultTimeout: defaultTimeout
        )

        let questions: [AgentAskUserQuestion]
        let includeLegacyResponse: Bool
        if hasStructuredQuestions {
            guard let questionValues = args["questions"]?.arrayValue else {
                throw MCPError.invalidParams("questions must be an array.")
            }
            guard !questionValues.isEmpty else {
                throw MCPError.invalidParams("ask_user requires at least one question.")
            }
            let maxQuestionCount = 10
            guard questionValues.count <= maxQuestionCount else {
                throw MCPError.invalidParams("ask_user supports at most \(maxQuestionCount) questions per request.")
            }
            questions = try questionValues.enumerated().map { index, value in
                try parseAskUserQuestion(value, index: index)
            }
            includeLegacyResponse = false
        } else {
            guard let questionText = normalizedAskUserString(args["question"]) else {
                throw MCPError.invalidParams("ask_user requires a questions array.")
            }
            let options = try parseAskUserOptions(args["options"], questionPath: "options")
            let multiSelect = try optionalAskUserBool(args["multi_select"], name: "multi_select") ?? false
            questions = [
                AgentAskUserQuestion(
                    id: "response",
                    question: questionText,
                    options: options,
                    allowsMultiple: multiSelect,
                    allowsCustom: true
                )
            ]
            includeLegacyResponse = true
        }

        let interaction = AgentAskUserInteraction(
            title: normalizedAskUserString(args["title"]) ?? (includeLegacyResponse ? "Question" : nil),
            context: normalizedAskUserString(args["context"]),
            timeoutSeconds: timeoutSeconds,
            questions: questions
        )
        do {
            try interaction.validate()
        } catch {
            throw MCPError.invalidParams(error.localizedDescription)
        }
        return ParsedAskUserInteraction(interaction: interaction, includeLegacyResponse: includeLegacyResponse)
    }

    private nonisolated static func parseAskUserQuestion(_ value: Value, index: Int) throws -> AgentAskUserQuestion {
        guard let object = value.objectValue else {
            throw MCPError.invalidParams("questions[\(index)] must be an object.")
        }
        guard let id = normalizedAskUserString(object["id"]) else {
            throw MCPError.invalidParams("questions[\(index)].id is required.")
        }
        guard let questionText = normalizedAskUserString(object["question"]) else {
            throw MCPError.invalidParams("questions[\(index)].question is required.")
        }
        if object["multi_select"] != nil {
            throw MCPError
                .invalidParams(
                    "questions[\(index)].multi_select has been renamed to questions[\(index)].allows_multiple."
                )
        }
        if object["allow_custom"] != nil {
            throw MCPError
                .invalidParams(
                    "questions[\(index)].allow_custom has been renamed to questions[\(index)].allows_custom."
                )
        }
        let options = try parseAskUserOptions(object["options"], questionPath: "questions['\(id)'].options")
        let allowsMultiple = try optionalAskUserBool(
            object["allows_multiple"],
            name: "questions[\(index)].allows_multiple"
        ) ?? false
        let allowsCustom = try optionalAskUserBool(
            object["allows_custom"],
            name: "questions[\(index)].allows_custom"
        ) ??
            true
        return AgentAskUserQuestion(
            id: id,
            header: normalizedAskUserString(object["header"]),
            question: questionText,
            context: normalizedAskUserString(object["context"]),
            options: options,
            allowsMultiple: allowsMultiple,
            allowsCustom: allowsCustom
        )
    }

    private nonisolated static func parseAskUserOptions(
        _ value: Value?, questionPath: String
    ) throws -> [AgentAskUserOption] {
        guard let value else { return [] }
        guard let optionValues = value.arrayValue else {
            throw MCPError.invalidParams("\(questionPath) must be an array.")
        }
        return try optionValues.enumerated().map { index, value in
            if let label = normalizedAskUserString(value) {
                return AgentAskUserOption(label: label)
            }
            guard let object = value.objectValue else {
                throw MCPError.invalidParams("\(questionPath)[\(index)] must be a string or object.")
            }
            guard let label = normalizedAskUserString(object["label"]) else {
                throw MCPError.invalidParams("\(questionPath)[\(index)].label is required.")
            }
            return AgentAskUserOption(
                label: label,
                description: normalizedAskUserString(object["description"])
            )
        }
    }

    private nonisolated static func normalizedAskUserString(_ value: Value?) -> String? {
        guard let raw = value?.stringValue else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private nonisolated static func optionalAskUserBool(_ value: Value?, name: String) throws -> Bool? {
        guard let value else { return nil }
        guard let bool = value.boolValue else {
            throw MCPError.invalidParams("\(name) must be a boolean.")
        }
        return bool
    }
}
