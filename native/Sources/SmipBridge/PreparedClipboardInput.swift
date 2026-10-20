import Foundation

struct CapturedSelectedGitDiff: Decodable { let id: String; let text: String }

struct PreparedClipboardInput: Decodable {
    let duplicateUserInstructionsAtTop: Bool
    let includeDatetimeInUserInstructions: Bool
    let promptSectionsOrder: [PromptSection]
    let copyPreset: CapturedCopyPreset
    let codemapBlocks: [String]
    let contentBlocks: [String]
    let fileTreeContent: String
    let selectedGitDiffs: [CapturedSelectedGitDiff]
    let gitDiff: String?
    let automaticGitDiff: String?
    let constraints: String
    let userInstructions: String
}

struct PreparedClipboardOperation {
    let input: PreparedClipboardInput

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: ["kind", "input"])
        let raw = try object.value("input")
        _ = try WireObject(raw, keys: [
            "duplicateUserInstructionsAtTop", "includeDatetimeInUserInstructions", "promptSectionsOrder",
            "copyPreset",
            "codemapBlocks", "contentBlocks",
            "fileTreeContent", "selectedGitDiffs", "gitDiff", "automaticGitDiff",
            "constraints", "userInstructions"
        ])
        let data = try JSONSerialization.data(withJSONObject: raw)
        do { input = try JSONDecoder().decode(PreparedClipboardInput.self, from: data) } catch is DecodingError {
            throw BridgeFailure("nativeProtocolError")
        }
    }

    func render() throws -> [String: Any] {
        let preset = input.copyPreset.resolve()
        let includeFiles = preset.includeFiles, includeUserPrompt = preset.includeUserPrompt
        let gitInclusion = preset.gitInclusion
        // Caller-required evidence is independent of the preset's optional selected-artifact policy.
        let selectedDiffs = gitInclusion == .none ? [] : input.selectedGitDiffs.filter {
            !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let needsAutomaticGit = gitInclusion != .none && selectedDiffs.isEmpty
        let optionalDiffs = needsAutomaticGit ? [input.automaticGitDiff].compactMap(\.self) : selectedDiffs.map(\.text)
        let gitDiff = (optionalDiffs + [input.gitDiff].compactMap(\.self)).joined(separator: "\n\n")
        let text = RPCEClipboardPackaging.generatePreparedClipboardContent(
            constraints: input.constraints, userInstructions: input.userInstructions,
            codemapBlocks: preset.codeMapUsage == CodeMapUsage.none ? [] : input.codemapBlocks,
            contentBlocks: input.contentBlocks,
            fileTreeContent: preset.includeFileTree == true && preset.fileTreeMode != FileTreeOption.none
                ? input.fileTreeContent : "",
            gitDiff: gitDiff,
            includeFiles: includeFiles, includeUserPrompt: includeUserPrompt,
            includeDatetimeInUserInstructions: input.includeDatetimeInUserInstructions,
            promptSectionsOrder: input.promptSectionsOrder,
            disabledPromptSections: [],
            duplicateUserInstructionsAtTop: input.duplicateUserInstructionsAtTop, tabTitle: nil)
        return ["kind": "preparedClipboard", "text": text, "selectedGitDiffIds": selectedDiffs.map(\.id),
                "needsAutomaticGit": needsAutomaticGit,
                "tokenInputs": ["promptText": includeUserPrompt ? input.userInstructions : "",
                                "selectedInstructionsText": input.constraints],
                "preset": input.copyPreset.wireResolved]
    }
}
