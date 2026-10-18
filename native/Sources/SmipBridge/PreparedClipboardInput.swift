import Foundation

struct PromptContextResolved { let storedPromptIds: [UUID]?; let includeMetaPrompts: Bool }
struct CapturedStoredPrompt: Decodable { let id: UUID; let title: String; let content: String }
struct CapturedSelectedGitDiff: Decodable { let id: String; let text: String }

enum ClipboardPresetKind: String, Decodable { case standard, plan, diffFollowUp, codeReview }

struct PreparedClipboardInput: Decodable {
    let duplicateUserInstructionsAtTop: Bool
    let includeDatetimeInUserInstructions: Bool
    let promptSectionsOrder: [PromptSection]
    let copyPreset: ClipboardPresetKind
    let storedPrompts: [CapturedStoredPrompt]
    let codemapBlocks: [String]
    let contentBlocks: [String]
    let fileTreeContent: String
    let selectedGitDiffs: [CapturedSelectedGitDiff]
    let gitDiff: String?
    let automaticGitDiff: String?
    let metaInstructions: [CapturedMeta]
    let userInstructions: String
}

struct PreparedClipboardOperation {
    let input: PreparedClipboardInput

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: ["kind", "input"])
        let raw = try object.value("input")
        _ = try WireObject(raw, keys: [
            "duplicateUserInstructionsAtTop", "includeDatetimeInUserInstructions", "promptSectionsOrder",
            "copyPreset", "storedPrompts",
            "codemapBlocks", "contentBlocks",
            "fileTreeContent", "selectedGitDiffs", "gitDiff", "automaticGitDiff",
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
        case .diffFollowUp: BuiltInCopyPresets.diffFollowUp
        case .codeReview: BuiltInCopyPresets.codeReview
        }
        guard let includeFiles = preset.includeFiles, let includeUserPrompt = preset.includeUserPrompt,
              let includeMetaPrompts = preset.includeMetaPrompts,
              let gitInclusion = preset.gitInclusion
        else {
            throw BridgeFailure("nativeProtocolError")
        }
        let promptIDs = preset.storedPromptIds
        let selection = ClipboardMetaSelection(storedPrompts: input.storedPrompts, metaInstructions: [])
        let metas = selection.metaInstructions(for: PromptContextResolved(
            storedPromptIds: promptIDs, includeMetaPrompts: includeMetaPrompts
        )) + input.metaInstructions.map { MetaInstruction(title: $0.title, content: $0.content) }
        // Caller-required evidence is independent of the preset's optional selected-artifact policy.
        let selectedDiffs = gitInclusion == .none ? [] : input.selectedGitDiffs.filter {
            !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let needsAutomaticGit = gitInclusion == .selected && selectedDiffs.isEmpty
        let optionalDiffs = needsAutomaticGit ? [input.automaticGitDiff].compactMap(\.self) : selectedDiffs.map(\.text)
        let gitDiff = (optionalDiffs + [input.gitDiff].compactMap(\.self)).joined(separator: "\n\n")
        let text = RPCEClipboardPackaging.generatePreparedClipboardContent(
            metaInstructions: metas, userInstructions: input.userInstructions,
            codemapBlocks: preset.codeMapUsage == CodeMapUsage.none ? [] : input.codemapBlocks,
            contentBlocks: input.contentBlocks,
            fileTreeContent: preset.includeFileTree == true && preset.fileTreeMode != FileTreeOption.none
                ? input.fileTreeContent : "",
            gitDiff: gitDiff,
            includeSavedPrompts: !metas.isEmpty, includeFiles: includeFiles, includeUserPrompt: includeUserPrompt,
            includeDatetimeInUserInstructions: input.includeDatetimeInUserInstructions,
            promptSectionsOrder: input.promptSectionsOrder,
            disabledPromptSections: [],
            duplicateUserInstructionsAtTop: input.duplicateUserInstructionsAtTop, tabTitle: nil
        )
        return ["kind": "preparedClipboard", "text": text, "selectedGitDiffIds": selectedDiffs.map(\.id),
                "needsAutomaticGit": needsAutomaticGit,
                "tokenInputs": ["promptText": includeUserPrompt ? input.userInstructions : "",
                                "selectedInstructionsText": metas.map(\.content).joined(separator: "\n\n")],
                "preset": [
                    "kind": input.copyPreset.rawValue, "gitInclusion": gitInclusion.rawValue,
                    "includeMetaPrompts": includeMetaPrompts,
                    "storedPromptIds": promptIDs.map { $0.map { $0.uuidString.lowercased() } } as Any? ?? NSNull()
                ]]
    }
}
