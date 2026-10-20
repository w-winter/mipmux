// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: captured settings replace the app view model; resolver methods retain their original bodies.
import Foundation

struct PromptContextResolved: Codable {
    var includeFiles: Bool
    var includeUserPrompt: Bool
    var includeFileTree: Bool
    var fileTreeMode: FileTreeOption
    var codeMapUsage: CodeMapUsage
    var gitInclusion: GitInclusion
}

struct CopyCustomizations: Decodable {
    let includeFiles: Bool?
    let includeUserPrompt: Bool?
    let includeFileTree: Bool?
    let fileTreeMode: FileTreeOption?
    let codeMapUsage: CodeMapUsage?
    let gitInclusion: GitInclusion?
}

enum GitDiffInclusionMode: String, Decodable { case none, selectedFiles, all }
struct CapturedGitSettings: Decodable { let gitDiffInclusionMode: GitDiffInclusionMode }
struct CapturedCopySettings: Decodable {
    struct Current: Decodable {
        let fileTreeMode: FileTreeOption
        let codeMapUsage: CodeMapUsage
        let gitInclusion: GitDiffInclusionMode
    }

    let current: Current
    let customizations: CopyCustomizations
    let codeMapsGloballyDisabled: Bool
    let activeGitRoot: String?
    let presets: [CopyPreset]
}

struct ClipboardPresetResolver {
    let fileTreeOption: FileTreeOption
    let codeMapUsage: CodeMapUsage
    let codeMapsGloballyDisabled: Bool
    let gitViewModel: CapturedGitSettings
    nonisolated static func resolveCopyCodeMapUsage(
        isManualPreset: Bool,
        customCodeMapUsage _: CodeMapUsage?,
        presetCodeMapUsage: CodeMapUsage?,
        uiCodeMapUsage: CodeMapUsage,
        globallyDisabled: Bool = false) -> CodeMapUsage {
        guard !globallyDisabled else { return .none }
        if isManualPreset {
            return uiCodeMapUsage
        }
        return presetCodeMapUsage ?? uiCodeMapUsage
    }

    func resolvePromptContext(_ preset: CopyPreset, custom: CopyCustomizations?) -> PromptContextResolved {
        // Manual preset is the only place where per-workspace overrides apply
        let isManualPreset = (preset.builtInKind == .manual) || (preset.id == BuiltInCopyPresets.manual.id)
        let effectiveCustom = isManualPreset ? custom : nil

        let includeFiles = (effectiveCustom?.includeFiles ?? preset.includeFiles) ?? true
        let includeUserPrompt = (effectiveCustom?.includeUserPrompt ?? preset.includeUserPrompt) ?? true
        let includeFileTree = (effectiveCustom?.includeFileTree ?? preset.includeFileTree) ?? true

        // File-tree and code-map behaviour (fallback to current UI)
        let desiredFileTreeMode = effectiveCustom?.fileTreeMode ?? preset.fileTreeMode ?? fileTreeOption

        let desiredCodeMapUsage = Self.resolveCopyCodeMapUsage(
            isManualPreset: isManualPreset,
            customCodeMapUsage: effectiveCustom?.codeMapUsage,
            presetCodeMapUsage: preset.codeMapUsage,
            uiCodeMapUsage: codeMapUsage,
            globallyDisabled: codeMapsGloballyDisabled)

        let desiredGitInclusion = Self.mapGitInclusion(
            custom: effectiveCustom?.gitInclusion,
            preset: preset.gitInclusion,
            uiMode: gitViewModel.gitDiffInclusionMode,
            isManualPreset: isManualPreset)

        return PromptContextResolved(
            includeFiles: includeFiles,
            includeUserPrompt: includeUserPrompt,
            includeFileTree: includeFileTree,
            fileTreeMode: desiredFileTreeMode,
            codeMapUsage: desiredCodeMapUsage,
            gitInclusion: desiredGitInclusion)
    }

    // swiftlint:disable identifier_name
    static func mapGitInclusion(
        custom: GitInclusion?,
        preset: GitInclusion?,
        uiMode: GitDiffInclusionMode,
        isManualPreset: Bool) -> GitInclusion {
        if let c = custom {
            return c
        }
        if let p = preset {
            return p
        }
        if isManualPreset {
            switch uiMode {
            case .none:
                return .none
            case .selectedFiles:
                return .selected
            case .all:
                return .complete
            }
        }
        return .none
    }
    // swiftlint:enable identifier_name
}
