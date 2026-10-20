// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Native JSON adapters replace MCP and app runtime dependencies.
import Foundation

enum MCPAskUserElicitationBridge {
    struct Question {
        let id: String
        let text: String
        let context: String?
        let optionLabels: [String]
        let allowsMultiple: Bool
        let allowsCustom: Bool
    }

    static func questions(from interaction: AgentAskUserInteraction) -> [Question] {
        interaction.questions.map { question in
            Question(
                id: question.id,
                text: question.question,
                context: question.context,
                optionLabels: question.optionLabels,
                allowsMultiple: question.allowsMultiple,
                allowsCustom: question.allowsCustom
            )
        }
    }

    static func schema(
        from payload: [String: Value],
        questions: [Question]
    ) -> Elicitation.RequestSchema {
        var properties: [String: Value] = [:]
        for question in questions {
            var descriptionParts = [question.text]
            if let context = question.context {
                descriptionParts.append(context)
            }
            if question.allowsCustom, !question.optionLabels.isEmpty {
                descriptionParts.append("Suggested answers: \(question.optionLabels.joined(separator: ", "))")
            }
            var itemSchema: [String: Value] = [
                "type": .string("string")
            ]
            if !question.allowsCustom, !question.optionLabels.isEmpty {
                itemSchema["enum"] = .array(question.optionLabels.map(Value.string))
            }
            var property: [String: Value] = [
                "title": .string(question.text),
                "description": .string(descriptionParts.joined(separator: "\n"))
            ]
            if question.allowsMultiple {
                property["type"] = .string("array")
                property["items"] = .object(itemSchema)
                property["uniqueItems"] = .bool(true)
            } else {
                property.merge(itemSchema) { _, itemValue in itemValue }
            }
            properties[question.id] = .object(property)
        }
        return Elicitation.RequestSchema(
            title: normalizedString(payload["title"]),
            description: normalizedString(payload["context"]),
            properties: properties,
            required: nil
        )
    }

    static func response(
        questions: [Question],
        content: [String: Value],
        elapsedSeconds: Int,
        includeLegacyResponse: Bool
    ) -> Value {
        var answers: [String: Value] = [:]
        for question in questions {
            let values = strings(content[question.id])
            let optionSet = Set(question.optionLabels)
            let selected = values.filter(optionSet.contains)
            let custom = values.first { !optionSet.contains($0) }
            answers[question.id] = answer(
                values: values,
                selected: selected,
                custom: custom,
                skipped: values.isEmpty
            )
        }
        var object: [String: Value] = [
            "answers": .object(answers),
            "timed_out": .bool(false),
            "skipped": .bool(false),
            "elapsed_seconds": .int(elapsedSeconds)
        ]
        if includeLegacyResponse {
            object["response"] = strings(content["response"]).first.map(Value.string) ?? .null
        }
        return .object(object)
    }

    static func skippedResponse(
        questions: [Question],
        elapsedSeconds: Int,
        includeLegacyResponse: Bool
    ) -> Value {
        var answers: [String: Value] = [:]
        for question in questions {
            answers[question.id] = answer(values: [], selected: [], custom: nil, skipped: true)
        }
        var object: [String: Value] = [
            "answers": .object(answers),
            "timed_out": .bool(false),
            "skipped": .bool(true),
            "elapsed_seconds": .int(elapsedSeconds)
        ]
        if includeLegacyResponse {
            object["response"] = .null
        }
        return .object(object)
    }

    private static func answer(
        values: [String],
        selected: [String],
        custom: String?,
        skipped: Bool
    ) -> Value {
        .object([
            "answers": .array(values.map(Value.string)),
            "selected_options": .array(selected.map(Value.string)),
            "custom_response": custom.map(Value.string) ?? .null,
            "skipped": .bool(skipped)
        ])
    }

    static func message(from payload: [String: Value], questions: [Question]) -> String {
        var parts: [String] = []
        if let title = normalizedString(payload["title"]) {
            parts.append(title)
        }
        if let context = normalizedString(payload["context"]) {
            parts.append(context)
        }
        parts.append(contentsOf: questions.map(\.text))
        return parts.joined(separator: "\n\n")
    }

    private static func strings(_ value: Value?) -> [String] {
        guard let value else { return [] }
        if let string = normalizedString(value) { return [string] }
        return value.arrayValue?.compactMap(normalizedString) ?? []
    }

    private static func normalizedString(_ value: Value?) -> String? {
        guard let string = value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !string.isEmpty
        else {
            return nil
        }
        return string
    }
}
