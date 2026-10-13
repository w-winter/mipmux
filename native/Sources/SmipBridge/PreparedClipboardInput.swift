import Foundation

struct PromptContextResolved { let storedPromptIds: [UUID]?; let includeMetaPrompts: Bool }
struct CapturedStoredPrompt: Decodable { let id: UUID; let title: String; let content: String }

enum ClipboardPresetKind: String, Decodable { case standard, codeReview }

struct PreparedClipboardInput: Decodable {
    let copyPreset: ClipboardPresetKind
    let storedPrompts: [CapturedStoredPrompt]
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
            "copyPreset", "storedPrompts", "codemapBlocks", "contentBlocks", "fileTreeContent", "gitDiff",
            "metaInstructions", "userInstructions"
        ])
        let data = try JSONSerialization.data(withJSONObject: raw)
        do { input = try JSONDecoder().decode(PreparedClipboardInput.self, from: data) } catch is DecodingError {
            throw BridgeFailure("nativeProtocolError")
        }
    }

    func render() throws -> [String: Any] {
        let preset = input.copyPreset == .standard ? BuiltInCopyPresets.standard : BuiltInCopyPresets.codeReview
        guard let includeFiles = preset.includeFiles, let includeUserPrompt = preset.includeUserPrompt,
              let includeMetaPrompts = preset.includeMetaPrompts, let promptIDs = preset.storedPromptIds else {
            throw BridgeFailure("nativeProtocolError")
        }
        let selection = ClipboardMetaSelection(storedPrompts: input.storedPrompts, metaInstructions: [])
        let metas = selection.metaInstructions(for: PromptContextResolved(
            storedPromptIds: promptIDs, includeMetaPrompts: includeMetaPrompts
        )) + input.metaInstructions.map { MetaInstruction(title: $0.title, content: $0.content) }
        let text = RPCEClipboardPackaging.generatePreparedClipboardContent(
            metaInstructions: metas, userInstructions: input.userInstructions, codemapBlocks: input.codemapBlocks,
            contentBlocks: input.contentBlocks, fileTreeContent: input.fileTreeContent, gitDiff: input.gitDiff,
            includeSavedPrompts: !metas.isEmpty, includeFiles: includeFiles, includeUserPrompt: includeUserPrompt,
            includeDatetimeInUserInstructions: false, promptSectionsOrder: PromptAssemblyBuilder.defaultSectionOrder,
            disabledPromptSections: [], duplicateUserInstructionsAtTop: false, tabTitle: nil
        )
        return ["kind": "preparedClipboard", "text": text, "preset": [
            "kind": input.copyPreset.rawValue, "includeMetaPrompts": includeMetaPrompts,
            "storedPromptIds": promptIDs.map { $0.uuidString.lowercased() }
        ]]
    }
}
