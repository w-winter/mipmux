import Foundation

enum FilePathDisplay: String, Decodable { case full, relative }
enum EntryRole: String, Decodable { case ordinary, authorizedGitDiffArtifact }
struct CapturedFile: Decodable {
    let id: String
    let rootID: String
    let name: String
    let relativePath: String
    let fullPath: String
}

struct ResolvedPromptFileEntry: Decodable {
    let file: CapturedFile
    let role: EntryRole
    let isCodemap: Bool
    let loadedContent: String?
    let lineRanges: [LineRange]?
    let rootFolderPath: String?
}

struct CapturedCodemap: Decodable { let text: String }
struct WorkspaceCodemapOperationPresentation: Decodable {
    let renderedEntriesByFileID: [String: CapturedCodemap]
}

struct ResolvedPromptFileBlockRecord {
    let entry: ResolvedPromptFileEntry
    let file: CapturedFile
    let text: String
    let isCodemap: Bool
}

struct ClipboardInput: Decodable {
    let constraints: String
    let userInstructions: String
    let files: [ResolvedPromptFileEntry]
    let fileTreeContent: String?
    let gitDiff: String?
    let includeFiles: Bool
    let includeUserPrompt: Bool
    let includeDatetimeInUserInstructions: Bool
    let filePathDisplay: FilePathDisplay
    let codemapPresentation: WorkspaceCodemapOperationPresentation
    let promptSectionsOrder: [PromptSection]
    let disabledPromptSections: [PromptSection]
    let duplicateUserInstructionsAtTop: Bool
    let tabTitle: String?
}

struct ClipboardOperation {
    let input: ClipboardInput
    init(_ value: Any) throws {
        let object = try WireObject(value, keys: ["kind", "input"])
        let raw = try object.value("input")
        _ = try WireObject(raw, keys: [
            "constraints", "userInstructions", "files", "fileTreeContent", "gitDiff",
            "includeFiles", "includeUserPrompt", "includeDatetimeInUserInstructions",
            "filePathDisplay", "codemapPresentation", "promptSectionsOrder", "disabledPromptSections",
            "duplicateUserInstructionsAtTop", "tabTitle"
        ])
        let data = try JSONSerialization.data(withJSONObject: raw)
        do { input = try JSONDecoder().decode(ClipboardInput.self, from: data) } catch is DecodingError {
            throw BridgeFailure("nativeProtocolError")
        }
    }

    func render() async -> [String: Any] {
        let text = await RPCEClipboardPackaging.generateClipboardContent(
            constraints: input.constraints,
            userInstructions: input.userInstructions, files: input.files, fileTreeContent: input.fileTreeContent,
            gitDiff: input.gitDiff, includeFiles: input.includeFiles,
            includeUserPrompt: input.includeUserPrompt, filePathDisplay: input.filePathDisplay,
            codemapPresentation: input.codemapPresentation,
            includeDatetimeInUserInstructions: input.includeDatetimeInUserInstructions,
            promptSectionsOrder: input.promptSectionsOrder, disabledPromptSections: Set(input.disabledPromptSections),
            duplicateUserInstructionsAtTop: input.duplicateUserInstructionsAtTop, tabTitle: input.tabTitle)
        return ["kind": "clipboard", "text": text]
    }
}
