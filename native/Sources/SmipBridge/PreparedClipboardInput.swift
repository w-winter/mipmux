import Foundation

struct PromptContextResolved { let storedPromptIds: [UUID]?; let includeMetaPrompts: Bool }
struct CapturedStoredPrompt: Decodable { let id: UUID; let title: String; let content: String }

enum ClipboardPresetKind: String, Decodable { case standard, plan, codeReview }

struct PreparedClipboardInput: Decodable {
    let duplicateUserInstructionsAtTop: Bool
    let copyPreset: ClipboardPresetKind
    let storedPrompts: [CapturedStoredPrompt]
    let codemapBlocks: [String]
    let contentBlocks: [String]
    let fileTreeContent: String
    let selectedGitDiffs: [String]
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
            "duplicateUserInstructionsAtTop", "copyPreset", "storedPrompts", "codemapBlocks", "contentBlocks",
            "fileTreeContent", "selectedGitDiffs", "gitDiff",
            "metaInstructions", "userInstructions"
        ])
        let data = try JSONSerialization.data(withJSONObject: raw)
        do { input = try JSONDecoder().decode(PreparedClipboardInput.self, from: data) } catch is DecodingError {
            throw BridgeFailure("nativeProtocolError")
        }
    }

    func render() throws -> [String: Any] {
        let preset = switch input.copyPreset {
        case .standard: BuiltInCopyPresets.standard
        case .plan: BuiltInCopyPresets.plan
        case .codeReview: BuiltInCopyPresets.codeReview
        }
        guard let includeFiles = preset.includeFiles, let includeUserPrompt = preset.includeUserPrompt,
              let includeMetaPrompts = preset.includeMetaPrompts, let promptIDs = preset.storedPromptIds,
              let gitInclusion = preset.gitInclusion
        else {
            throw BridgeFailure("nativeProtocolError")
        }
        let selection = ClipboardMetaSelection(storedPrompts: input.storedPrompts, metaInstructions: [])
        let metas = selection.metaInstructions(for: PromptContextResolved(
            storedPromptIds: promptIDs, includeMetaPrompts: includeMetaPrompts
        )) + input.metaInstructions.map { MetaInstruction(title: $0.title, content: $0.content) }
        // Caller-required evidence is independent of the preset's optional selected-artifact policy.
        let selectedDiffs = gitInclusion == .none ? [] : input.selectedGitDiffs
        let gitDiff = (selectedDiffs + [input.gitDiff].compactMap(\.self)).joined(separator: "\n\n")
        let text = RPCEClipboardPackaging.generatePreparedClipboardContent(
            metaInstructions: metas, userInstructions: input.userInstructions, codemapBlocks: input.codemapBlocks,
            contentBlocks: input.contentBlocks, fileTreeContent: input.fileTreeContent, gitDiff: gitDiff,
            includeSavedPrompts: !metas.isEmpty, includeFiles: includeFiles, includeUserPrompt: includeUserPrompt,
            includeDatetimeInUserInstructions: false, promptSectionsOrder: PromptAssemblyBuilder.defaultSectionOrder,
            disabledPromptSections: [],
            duplicateUserInstructionsAtTop: input.duplicateUserInstructionsAtTop, tabTitle: nil
        )
        return ["kind": "preparedClipboard", "text": text, "preset": [
            "kind": input.copyPreset.rawValue, "gitInclusion": gitInclusion.rawValue,
            "includeMetaPrompts": includeMetaPrompts,
            "storedPromptIds": promptIDs.map { $0.uuidString.lowercased() }
        ]]
    }
}
