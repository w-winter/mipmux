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
struct CapturedMeta: Decodable { let title: String; let content: String }
struct ClipboardInput: Decodable {
    let metaInstructions: [CapturedMeta]
    let userInstructions: String
    let files: [ResolvedPromptFileEntry]
    let fileTreeContent: String?
    let gitDiff: String?
    let includeSavedPrompts: Bool
    let includeFiles: Bool
    let includeUserPrompt: Bool
    let filePathDisplay: FilePathDisplay
    let codemapPresentation: WorkspaceCodemapOperationPresentation
    let promptSectionsOrder: [PromptSection]
    let disabledPromptSections: [PromptSection]
    let duplicateUserInstructionsAtTop: Bool
    let tabTitle: String?
}
struct Fixture: Decodable { let name: String; let input: ClipboardInput }
@main struct Main {
    static func main() async throws {
        let fixtures = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
        var results: [[String: String]] = []
        for fixture in fixtures {
            let input = fixture.input
            let suppliedGit = input.gitDiff
            let text = await PromptPackagingService.generateClipboardContent(
                metaInstructions: input.metaInstructions.map { MetaInstruction(title: $0.title, content: $0.content) },
                userInstructions: input.userInstructions, files: input.files,
                fileTreeContent: input.fileTreeContent, gitDiff: suppliedGit,
                includeSavedPrompts: input.includeSavedPrompts, includeFiles: input.includeFiles,
                includeUserPrompt: input.includeUserPrompt, filePathDisplay: input.filePathDisplay,
                codemapPresentation: input.codemapPresentation,
                includeDatetimeInUserInstructions: false, promptSectionsOrder: input.promptSectionsOrder,
                disabledPromptSections: Set(input.disabledPromptSections),
                duplicateUserInstructionsAtTop: input.duplicateUserInstructionsAtTop, tabTitle: input.tabTitle)
            results.append(["name": fixture.name, "text": text])
        }
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys]))
    }
}
