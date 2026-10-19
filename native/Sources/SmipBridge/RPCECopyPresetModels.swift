// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
import Foundation

// Modified: retain the model and initializer; persisted compatibility readers are not included.
enum CopyPresetKind: String, CaseIterable, Codable {
    case standard // Standard default preset
    case plan // Architect planning copy
    case manual // Manual current behavior
    case diffFollowUp // Git-selected only; no files/prompts/tree
    case codeReview // Review w/ git diff
}

struct CopyPreset: Identifiable, Equatable, Codable {
    let id: UUID
    let name: String
    let builtInKind: CopyPresetKind?
    let description: String?
    let icon: String? // e.g. "🏗️", "📝", "⚡", etc.
    let isBuiltIn: Bool

    // Behavior flags - nil means use current UI state
    var includeFiles: Bool?
    var includeUserPrompt: Bool?
    var includeMetaPrompts: Bool?
    var includeFileTree: Bool?

    // Content shaping - nil means use current UI state
    var fileTreeMode: FileTreeOption? // overrides PromptViewModel.fileTreeOption
    var codeMapUsage: CodeMapUsage? // overrides PromptViewModel.codeMapUsage
    var gitInclusion: GitInclusion? // git diff policy

    // Special prompt behaviors
    var storedPromptIds: [UUID]? // IDs of stored prompts to include
    var notes: String? // Additional notes for user reference

    // MARK: - Initializer

    init(
        id: UUID = UUID(),
        name: String,
        builtInKind: CopyPresetKind? = nil,
        description: String? = nil,
        icon: String? = nil,
        isBuiltIn: Bool = false,
        includeFiles: Bool? = nil,
        includeUserPrompt: Bool? = nil,
        includeMetaPrompts: Bool? = nil,
        includeFileTree: Bool? = nil,
        fileTreeMode: FileTreeOption? = nil,
        codeMapUsage: CodeMapUsage? = nil,
        gitInclusion: GitInclusion? = nil,
        storedPromptIds: [UUID]? = nil,
        notes: String? = nil
    ) {
        self.id = id
        self.name = name
        self.builtInKind = builtInKind
        self.description = description
        self.icon = icon
        self.isBuiltIn = isBuiltIn
        self.includeFiles = includeFiles
        self.includeUserPrompt = includeUserPrompt
        self.includeMetaPrompts = includeMetaPrompts
        self.includeFileTree = includeFileTree
        self.fileTreeMode = fileTreeMode
        self.codeMapUsage = codeMapUsage
        self.gitInclusion = gitInclusion
        self.storedPromptIds = storedPromptIds
        self.notes = notes
    }
}
