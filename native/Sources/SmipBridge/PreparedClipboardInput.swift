import Foundation

struct PreparedClipboardInput: Decodable {
    let codemapBlocks: [String]
    let contentBlocks: [String]
    let fileTreeContent: String
    let gitDiff: String?
    let metaInstructions: [CapturedMeta]
    let userInstructions: String
}

struct PreparedClipboardOperation {
    let input: PreparedClipboardInput

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: ["kind", "input"])
        let raw = try object.value("input")
        _ = try WireObject(raw, keys: [
            "codemapBlocks", "contentBlocks", "fileTreeContent", "gitDiff", "metaInstructions", "userInstructions"
        ])
        let data = try JSONSerialization.data(withJSONObject: raw)
        do { input = try JSONDecoder().decode(PreparedClipboardInput.self, from: data) } catch is DecodingError {
            throw BridgeFailure("nativeProtocolError")
        }
    }

    func render() -> [String: Any] {
        let text = RPCEClipboardPackaging.generatePreparedClipboardContent(
            metaInstructions: input.metaInstructions.map { MetaInstruction(title: $0.title, content: $0.content) },
            userInstructions: input.userInstructions, codemapBlocks: input.codemapBlocks,
            contentBlocks: input.contentBlocks, fileTreeContent: input.fileTreeContent, gitDiff: input.gitDiff,
            includeSavedPrompts: !input.metaInstructions.isEmpty, includeFiles: true, includeUserPrompt: true,
            includeDatetimeInUserInstructions: false, promptSectionsOrder: PromptAssemblyBuilder.defaultSectionOrder,
            disabledPromptSections: [], duplicateUserInstructionsAtTop: false, tabTitle: nil
        )
        return ["kind": "clipboard", "text": text]
    }
}
