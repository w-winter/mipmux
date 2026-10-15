// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Native JSON adapters replace MCP and app runtime dependencies.
import Foundation

enum AgentAskUserValidationError: LocalizedError, Equatable {
    case emptyQuestions
    case blankQuestionID(index: Int)
    case duplicateQuestionID(String)
    case blankQuestionText(id: String)
    case duplicateOptionLabel(questionID: String, label: String)
    case impossibleQuestion(questionID: String)
    case incompleteQuestion(String)
    case invalidSingleSelectAnswer(questionID: String)
    case invalidCustomAnswer(questionID: String)
    case invalidSelectedOption(questionID: String, label: String)
    case skippedQuestionHasAnswer(questionID: String)
    case inconsistentStructuredAnswer(questionID: String)
    case unknownQuestionID(id: String, validIDs: [String])

    // swiftlint:disable line_length
    var errorDescription: String? {
        switch self {
        case .emptyQuestions:
            "ask_user requires at least one question."
        case let .blankQuestionID(index):
            "ask_user question at index \(index) has a blank id."
        case let .duplicateQuestionID(id):
            "ask_user question id '\(id)' is duplicated."
        case let .blankQuestionText(id):
            "ask_user question '\(id)' has blank question text."
        case let .duplicateOptionLabel(questionID, label):
            "ask_user question '\(questionID)' has duplicate option label '\(label)'."
        case let .impossibleQuestion(questionID):
            "ask_user question '\(questionID)' has no options and does not allow custom responses."
        case let .incompleteQuestion(questionID):
            "ask_user question '\(questionID)' must be answered or skipped before submitting."
        case let .invalidSingleSelectAnswer(questionID):
            "ask_user question '\(questionID)' accepts only one selected option or one custom response."
        case let .invalidCustomAnswer(questionID):
            "ask_user question '\(questionID)' has an invalid custom response. Custom responses must be allowed and only one custom response may be provided."
        case let .invalidSelectedOption(questionID, label):
            "ask_user question '\(questionID)' has invalid selected option '\(label)'."
        case let .skippedQuestionHasAnswer(questionID):
            "ask_user question '\(questionID)' cannot be skipped and answered at the same time."
        case let .inconsistentStructuredAnswer(questionID):
            "ask_user question '\(questionID)' has inconsistent structured answers."
        case let .unknownQuestionID(id, validIDs):
            "ask_user answer references unknown question_id '\(id)'. Known IDs: \(validIDs.joined(separator: ", "))."
        }
    }
}

// swiftlint:enable line_length
struct AgentAskUserOption: Hashable {
    let label: String
    let description: String?

    init(label: String, description: String? = nil) {
        self.label = label
        self.description = description
    }
}

struct AgentAskUserQuestion: Hashable {
    let id: String
    let header: String?
    let question: String
    let context: String?
    let options: [AgentAskUserOption]
    let allowsMultiple: Bool
    let allowsCustom: Bool

    init(
        id: String,
        header: String? = nil,
        question: String,
        context: String? = nil,
        options: [AgentAskUserOption] = [],
        allowsMultiple: Bool = false,
        allowsCustom: Bool = true
    ) {
        self.id = id
        self.header = header
        self.question = question
        self.context = context
        self.options = options
        self.allowsMultiple = allowsMultiple
        self.allowsCustom = allowsCustom
    }

    var optionLabels: [String] {
        options.map(\.label)
    }

    func orderedSelectedOptions(from draft: AgentAskUserDraft) -> [String] {
        let selected = Set(draft.selectedOptionLabels)
        return optionLabels.filter { selected.contains($0) }
    }

    func answer(from draft: AgentAskUserDraft) -> AgentAskUserAnswer {
        if draft.skipped {
            return AgentAskUserAnswer(answers: [], selectedOptions: [], customResponse: nil, skipped: true)
        }

        var selectedOptions = orderedSelectedOptions(from: draft)
        let trimmedCustom = allowsCustom
            ? draft.customResponse.trimmingCharacters(in: .whitespacesAndNewlines)
            : ""
        let customResponse = trimmedCustom.isEmpty ? nil : trimmedCustom

        if !allowsMultiple, customResponse != nil {
            selectedOptions = []
        }

        var answers = selectedOptions
        if let customResponse {
            answers.append(customResponse)
        }
        return AgentAskUserAnswer(
            answers: answers,
            selectedOptions: selectedOptions,
            customResponse: customResponse,
            skipped: false
        )
    }

    func validate(_ answer: AgentAskUserAnswer) throws {
        guard allowsMultiple || answer.answers.count <= 1 else {
            throw AgentAskUserValidationError.invalidSingleSelectAnswer(questionID: id)
        }
    }
}

struct AgentAskUserDraft: Hashable {
    var selectedOptionLabels: [String]
    var customResponse: String
    var skipped: Bool

    init(
        selectedOptionLabels: [String] = [],
        customResponse: String = "",
        skipped: Bool = false
    ) {
        self.selectedOptionLabels = selectedOptionLabels
        self.customResponse = customResponse
        self.skipped = skipped
    }

    var hasContent: Bool {
        skipped
            || !selectedOptionLabels.isEmpty
            || !customResponse.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

struct AgentAskUserAnswer: Hashable {
    let answers: [String]
    let selectedOptions: [String]
    let customResponse: String?
    let skipped: Bool

    var jsonObject: [String: Any] {
        [
            "answers": answers,
            "selected_options": selectedOptions,
            "custom_response": customResponse ?? NSNull(),
            "skipped": skipped
        ]
    }
}

struct AgentAskUserResponse: Hashable {
    let answersByQuestionID: [String: AgentAskUserAnswer]
    let timedOut: Bool
    let skipped: Bool
    let elapsedSeconds: Int

    var jsonObject: [String: Any] {
        [
            "answers": answersByQuestionID.reduce(into: [String: [String: Any]]()) { partialResult, entry in
                partialResult[entry.key] = entry.value.jsonObject
            },
            "timed_out": timedOut,
            "skipped": skipped,
            "elapsed_seconds": elapsedSeconds
        ]
    }
}

struct AgentAskUserInteraction: Identifiable, Hashable {
    let id: UUID
    let title: String?
    let context: String?
    let timeoutSeconds: TimeInterval
    let askedAt: Date
    let questions: [AgentAskUserQuestion]

    init(
        id: UUID = UUID(),
        title: String? = nil,
        context: String? = nil,
        timeoutSeconds: TimeInterval = 300,
        askedAt: Date = Date(),
        questions: [AgentAskUserQuestion]
    ) {
        self.id = id
        self.title = title
        self.context = context
        self.timeoutSeconds = timeoutSeconds
        self.askedAt = askedAt
        self.questions = questions
    }

    func validate() throws {
        guard !questions.isEmpty else {
            throw AgentAskUserValidationError.emptyQuestions
        }
        var seenIDs = Set<String>()
        for (index, question) in questions.enumerated() {
            let questionID = question.id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !questionID.isEmpty else {
                throw AgentAskUserValidationError.blankQuestionID(index: index)
            }
            guard seenIDs.insert(questionID).inserted else {
                throw AgentAskUserValidationError.duplicateQuestionID(questionID)
            }
            guard !question.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw AgentAskUserValidationError.blankQuestionText(id: questionID)
            }
            guard question.allowsCustom || !question.options.isEmpty else {
                throw AgentAskUserValidationError.impossibleQuestion(questionID: questionID)
            }

            var optionLabels = Set<String>()
            for option in question.options {
                let label = option.label.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !label.isEmpty else {
                    throw AgentAskUserValidationError.duplicateOptionLabel(questionID: questionID, label: "")
                }
                guard optionLabels.insert(label).inserted else {
                    throw AgentAskUserValidationError.duplicateOptionLabel(questionID: questionID, label: label)
                }
            }
        }
    }

    func emptyDrafts() -> [String: AgentAskUserDraft] {
        questions.reduce(into: [String: AgentAskUserDraft]()) { partialResult, question in
            partialResult[question.id] = AgentAskUserDraft()
        }
    }

    func buildTimedOutResponse(
        drafts: [String: AgentAskUserDraft],
        elapsedSeconds: Int
    ) -> AgentAskUserResponse {
        (try? buildResponse(
            drafts: drafts,
            timedOut: true,
            skipped: false,
            elapsedSeconds: elapsedSeconds,
            requireComplete: false
        ))
            ?? AgentAskUserResponse(
                answersByQuestionID: [:],
                timedOut: true,
                skipped: false,
                elapsedSeconds: elapsedSeconds
            )
    }

    private func buildResponse(
        drafts: [String: AgentAskUserDraft],
        timedOut: Bool,
        skipped: Bool,
        elapsedSeconds: Int,
        requireComplete: Bool
    ) throws -> AgentAskUserResponse {
        try validate()
        var answers = [String: AgentAskUserAnswer]()
        for question in questions {
            let answer = question.answer(from: drafts[question.id] ?? AgentAskUserDraft())
            try question.validate(answer)
            if requireComplete, !answer.skipped, answer.answers.isEmpty {
                throw AgentAskUserValidationError.incompleteQuestion(question.id)
            }
            answers[question.id] = answer
        }
        return AgentAskUserResponse(
            answersByQuestionID: answers,
            timedOut: timedOut,
            skipped: skipped,
            elapsedSeconds: elapsedSeconds
        )
    }
}
