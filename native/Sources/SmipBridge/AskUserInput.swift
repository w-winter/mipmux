import Foundation

struct AskUserInput {
    let payload: [String: Value]
    let defaultTimeout: Int
    let response: Response?

    struct Response {
        let action: String
        let content: [String: Value]
        let elapsedSeconds: Int
    }

    init(_ raw: Any) throws {
        guard let fields = raw as? [String: Any], let kind = fields["kind"] as? String else {
            throw BridgeFailure("nativeProtocolError")
        }
        let answering = kind == "answerAskUser"
        let keys: Set = ["kind", "payload", "defaultTimeoutSeconds"]
        let object = try WireObject(raw, keys: answering ? keys.union(["action", "content", "elapsedSeconds"]) : keys)
        guard let payload = try Value(object.value("payload")).objectValue
        else { throw BridgeFailure("nativeProtocolError") }
        self.payload = payload
        defaultTimeout = try object.count("defaultTimeoutSeconds")
        if answering {
            let action = try object.string("action")
            guard ["accept", "decline", "timeout"].contains(action),
                  let content = try Value(object.value("content")).objectValue
            else { throw BridgeFailure("nativeProtocolError") }
            response = try Response(action: action, content: content, elapsedSeconds: object.count("elapsedSeconds"))
        } else {
            response = nil
        }
    }

    func render() throws -> [String: Any] {
        do {
            let parsed = try MCPAskUserToolProvider.parseAskUserInteraction(
                args: payload,
                defaultTimeout: TimeInterval(defaultTimeout)
            )
            let questions = MCPAskUserElicitationBridge.questions(from: parsed.interaction)
            if let response {
                let value: Value
                switch response.action {
                case "accept":
                    value = MCPAskUserElicitationBridge.response(questions: questions, content: response.content,
                                                                 elapsedSeconds: response.elapsedSeconds,
                                                                 includeLegacyResponse: parsed.includeLegacyResponse)
                case "decline":
                    value = MCPAskUserElicitationBridge.skippedResponse(
                        questions: questions,
                        elapsedSeconds: response.elapsedSeconds,
                        includeLegacyResponse: parsed.includeLegacyResponse
                    )
                default:
                    let answer = parsed.interaction.buildTimedOutResponse(
                        drafts: parsed.interaction.emptyDrafts(),
                        elapsedSeconds: response.elapsedSeconds
                    )
                    var result = answer.jsonObject
                    if parsed.includeLegacyResponse { result["response"] = NSNull() }
                    return ["kind": "askUserAnswered", "response": result]
                }
                return try ["kind": "askUserAnswered", "response": value.json]
            }
            let schema = MCPAskUserElicitationBridge.schema(from: payload, questions: questions)
            return try [
                "kind": "askUserPrepared",
                "message": MCPAskUserElicitationBridge.message(from: payload, questions: questions),
                "timeoutSeconds": parsed.interaction.timeoutSeconds,
                "requestedSchema": schema.json,
                "fields": questions.map { question in
                    try ["id": question.id, "optionLabels": question.optionLabels,
                         "property": schema.properties[question.id]!.json] as [String: Any]
                }
            ]
        } catch let error as MCPError {
            return ["kind": "askUserInvalid", "message": error.localizedDescription]
        } catch let error as AgentAskUserValidationError {
            return ["kind": "askUserInvalid", "message": error.localizedDescription]
        }
    }
}
